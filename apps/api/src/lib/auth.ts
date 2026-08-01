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
