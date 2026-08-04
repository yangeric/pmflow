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

// ── 給機器用的長期權杖 ──────────────────────────────────
/**
 * 權杖的固定開頭。有這個字串才做得到兩件事：
 *  1. 驗證時不用猜 —— 看一眼就知道該走權杖那條路還是 JWT 那條路。
 *  2. 誤貼進程式碼、貼進聊天室時，掃描工具有東西可以比對。
 * 改這個字串等於讓所有已發出的權杖失效，不要動。
 */
export const API_TOKEN_PREFIX = 'pmflow_'

/** 清單上顯示的可辨識片段長度（前綴 + 7 碼亂數） */
const API_TOKEN_HINT_LEN = API_TOKEN_PREFIX.length + 7

/**
 * 32 位元組亂數 = 256 位元熵，猜中的機率跟猜中 UUID 一樣不值得討論。
 *
 * 雜湊用 sha256 而不是 scrypt：這不是使用者取的密碼，沒有字典可查，
 * 慢雜湊擋的攻擊在這裡不存在；而每一次 API 呼叫都要驗一次，
 * scrypt 的 100ms 成本會讓外部系統根本沒辦法用。跟 refresh token 同理。
 */
export function newApiToken() {
  const raw = API_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return {
    raw,
    hash: hashApiToken(raw),
    prefix: raw.slice(0, API_TOKEN_HINT_LEN),
  }
}

export const hashApiToken = (raw: string) =>
  createHash('sha256').update(raw).digest('hex')

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
    /** 這次請求是哪一把權杖帶進來的。走 JWT 進來就是 undefined */
    apiTokenId?: string
  }
}

/**
 * 驗證 Authorization: Bearer，掛到 request.user。
 *
 * 兩種憑證共用同一個入口，因為**權限完全一樣** —— 拿權杖呼叫就等於發權杖的
 * 那個人在呼叫，後面所有 require* 檢查都不必知道差別。刻意不為機器另外發明
 * 一套角色：多一套就多一個會跟主線走鐘的地方，人離職時也收不乾淨。
 *
 * 走哪一條看開頭：我們自己發的權杖一定以 API_TOKEN_PREFIX 起頭，JWT 不可能
 * 長成那樣（它一定是 base64url 的 `{"alg"...` 也就是 `eyJ`）。所以既有的
 * 瀏覽器登入那條路的行為一個字都沒有改變。
 */
export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw unauthorized()
  const credential = header.slice(7)

  if (credential.startsWith(API_TOKEN_PREFIX)) return authenticateApiToken(req, credential)

  try {
    const { payload } = await jwtVerify(credential, secretKey)
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

/**
 * 權杖驗證。查得到雜湊只是第一關，還要確認它沒被撤銷、沒過期，
 * 而且**背後那個人現在還是啟用中的帳號** —— 帳號被停用時沒有人會記得去
 * 撤他的權杖，所以這裡每次都重新確認一次 status。
 */
async function authenticateApiToken(req: FastifyRequest, raw: string): Promise<AuthUser> {
  const [row] = await sql<{
    id: string; user_id: string; email: string; display_name: string
    status: string; revoked: boolean; expired: boolean; stale: boolean
  }[]>`
    SELECT t.id, t.user_id, u.email, u.display_name, u.status,
           (t.revoked_at IS NOT NULL) AS revoked,
           (t.expires_at IS NOT NULL AND t.expires_at < now()) AS expired,
           (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute') AS stale
    FROM api_token t JOIN app_user u ON u.id = t.user_id
    WHERE t.token_hash = ${hashApiToken(raw)}`

  // 無效、撤銷、過期一律回同一句話：訊息分得越細，拿到權杖的人越好猜
  if (!row || row.revoked || row.expired) throw unauthorized('權杖無效、已撤銷或已過期')
  if (row.status !== 'ACTIVE') throw forbidden('這個帳號已被停用')

  // 「最後使用時間」只是給人看的參考值，不值得讓每一次呼叫都多一次寫入。
  // 一分鐘內只寫一次，而且不等它完成 —— 寫失敗也不該讓 API 呼叫失敗。
  if (row.stale) {
    void sql`UPDATE api_token SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {})
  }

  const user: AuthUser = { id: row.user_id, email: row.email, displayName: row.display_name }
  req.user = user
  req.apiTokenId = row.id
  return user
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

/** 工作區層級的角色。OWNER 是開站的人，ADMIN 是他指定的、真正在管帳號的人 */
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'

/**
 * 站台管理者才能做的事：開帳號、停用帳號、刪帳號、代設密碼。
 *
 * **擁有者刻意不算在內。** 開站的人不必然是該看每個人帳號的人 ——
 * 他只保留一項權力：指派與取消管理者（requireWorkspaceOwner）。
 * 這樣切是為了讓「誰能看別人的帳號」是一個被明確授予的職務，
 * 而不是誰先把站架起來誰就順便什麼都看得到。
 *
 * 那為什麼擁有者還留著指派管理者的權力？因為不留就死結了：
 * 最後一個管理者離職之後，沒有人能再指派下一個，整個站就鎖死。
 *
 * 跟專案的權限是兩件事 —— 專案裡誰能進來由專案建立者決定（requireProjectCreator），
 * 但「這個人能不能登入這個站」是工作區管理者的事。管理者不會因此自動看得到
 * 每個專案的內容，那仍然要專案建立者放行。
 */
export async function requireWorkspaceAdmin(
  userId: string, workspaceId: string
): Promise<{ role: WorkspaceRole }> {
  const { role } = await requireWorkspaceMember(userId, workspaceId)
  if (role !== 'ADMIN') {
    throw forbidden(
      role === 'OWNER'
        ? '擁有者不能查看或管理別人的帳號，只能指派管理者'
        : '這個操作需要工作區管理者權限'
    )
  }
  return { role: role as WorkspaceRole }
}

/** 擁有者專用。他唯一還能對別人的帳號做的事，就是決定誰是管理者 */
export async function requireWorkspaceOwner(
  userId: string, workspaceId: string
): Promise<{ role: WorkspaceRole }> {
  const { role } = await requireWorkspaceMember(userId, workspaceId)
  if (role !== 'OWNER') throw forbidden('只有工作區的擁有者可以指派管理者')
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
