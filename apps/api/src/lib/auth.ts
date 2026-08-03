import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { SignJWT, jwtVerify } from 'jose'
import type { FastifyRequest } from 'fastify'
import { env } from './env.js'
import { sql } from './db.js'
import { unauthorized, forbidden } from './errors.js'

const scrypt = promisify(_scrypt) as (
  pw: string | Buffer, salt: string | Buffer, len: number, opts?: object
) => Promise<Buffer>

// scrypt 是 Node 內建的，不用任何原生相依 —— Alpine 容器裡不會有編譯問題。
// N=2^15 在一般硬體上約 100ms，對登入來說是合適的成本。
// maxmem 必須明講：需要 128*N*r ≈ 33.5MB，超過 Node 預設的 32MB 上限，
// 不設會直接噴 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
const SCRYPT = { N: 32768, r: 8, p: 1 }
const MAXMEM = 96 * 1024 * 1024
const KEYLEN = 64

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, KEYLEN, { ...SCRYPT, maxmem: MAXMEM })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const [alg, N, r, p, saltB64, keyB64] = stored.split('$')
  if (alg !== 'scrypt') return false
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scrypt(pw, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: MAXMEM })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const secretKey = new TextEncoder().encode(env.jwtSecret)

export interface AuthUser {
  id: string
  email: string
  displayName: string
}

export async function signAccessToken(u: AuthUser): Promise<string> {
  return new SignJWT({ email: u.email, name: u.displayName })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.id)
    .setIssuedAt()
    .setExpirationTime(`${env.accessTtlSec}s`)
    .sign(secretKey)
}

export function newRefreshToken() {
  const raw = randomBytes(48).toString('base64url')
  return { raw, hash: createHash('sha256').update(raw).digest('hex') }
}

export const hashRefreshToken = (raw: string) =>
  createHash('sha256').update(raw).digest('hex')

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

/** 驗證 Bearer token，掛到 request.user。系統只有這一種驗證主體。 */
export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw unauthorized()
  try {
    const { payload } = await jwtVerify(header.slice(7), secretKey)
    const user: AuthUser = {
      id: payload.sub as string,
      email: payload.email as string,
      displayName: payload.name as string,
    }
    req.user = user
    return user
  } catch {
    throw unauthorized('登入已過期，請重新登入')
  }
}

export type ProjectRole = 'MANAGER' | 'EDITOR' | 'COMMENTER' | 'VIEWER'
const RANK: Record<ProjectRole, number> = { VIEWER: 0, COMMENTER: 1, EDITOR: 2, MANAGER: 3 }

/**
 * 專案層權限檢查。所有路由都必須走這裡拿 projectId，
 * 不可以直接信任前端傳來的 workspaceId。
 */
export async function requireProjectRole(
  userId: string, projectId: string, min: ProjectRole
): Promise<{ role: ProjectRole; workspaceId: string }> {
  const rows = await sql<{ role: ProjectRole; workspace_id: string }[]>`
    SELECT pm.role, p.workspace_id
    FROM project p
    JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = ${userId}
    WHERE p.id = ${projectId}`
  if (!rows.length) throw forbidden('你不是這個專案的成員')
  const { role, workspace_id } = rows[0]
  if (RANK[role] < RANK[min]) throw forbidden(`這個操作需要 ${min} 以上權限，你目前是 ${role}`)
  return { role, workspaceId: workspace_id }
}

/**
 * 只有專案創立者能做的事：放人進來、核准或婉拒申請、把人移出去。
 *
 * 刻意不接受 MANAGER —— 使用者要的是「這個專案是誰開的，誰才能決定誰進得來」。
 * MANAGER 是能改專案內容的角色，可以有很多個，跟「開專案的人」不是同一件事。
 */
export async function requireProjectCreator(
  userId: string, projectId: string
): Promise<{ workspaceId: string }> {
  const rows = await sql<{ workspace_id: string; created_by: string | null }[]>`
    SELECT workspace_id, created_by FROM project WHERE id = ${projectId}`
  if (!rows.length) throw forbidden('找不到專案，或你沒有權限')
  if (rows[0].created_by !== userId) {
    throw forbidden('只有專案的建立者可以管理成員')
  }
  return { workspaceId: rows[0].workspace_id }
}

/** 同一個工作區的成員才看得到、才申請得了這個工作區裡的專案 */
export async function requireWorkspaceMember(
  userId: string, workspaceId: string
): Promise<{ role: string }> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM workspace_member
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`
  if (!rows.length) throw forbidden('你不是這個工作區的成員')
  return rows[0]
}

/** 工作區層級的角色。OWNER 是開站的人，ADMIN 是他指定的幫手 */
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'

/**
 * 站台管理者才能做的事：開帳號、停用帳號、調整別人的工作區角色。
 *
 * 跟專案的權限是兩件事 —— 專案裡誰能進來由專案建立者決定（requireProjectCreator），
 * 但「這個人能不能登入這個站」是工作區管理者的事。管理者不會因此自動看得到
 * 每個專案的內容，那仍然要專案建立者放行。
 */
export async function requireWorkspaceAdmin(
  userId: string, workspaceId: string
): Promise<{ role: WorkspaceRole }> {
  const { role } = await requireWorkspaceMember(userId, workspaceId)
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw forbidden('這個操作需要工作區管理者權限')
  }
  return { role: role as WorkspaceRole }
}

/**
 * 由 task id 反查專案再驗權限。
 * 子資源端點（/tasks/:id、/inquiries/:id、/links/:id）一定要走這條，
 * 不能因為前端拿得到 id 就放行 —— 這正是 Vikunja 2026 那個關聯 IDOR 的成因。
 */
export async function requireTaskAccess(
  userId: string, taskId: string, min: ProjectRole
): Promise<{ role: ProjectRole; workspaceId: string; projectId: string }> {
  const rows = await sql<{ project_id: string }[]>`
    SELECT project_id FROM task WHERE id = ${taskId} AND deleted_at IS NULL`
  if (!rows.length) throw forbidden('找不到任務，或你沒有權限')
  const projectId = rows[0].project_id
  const r = await requireProjectRole(userId, projectId, min)
  return { ...r, projectId }
}
