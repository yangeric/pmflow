import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { env } from '../lib/env.js'
import {
  hashPassword, verifyPassword, signAccessToken,
  newRefreshToken, hashRefreshToken, authenticate,
} from '../lib/auth.js'
import { badRequest, unauthorized, forbidden } from '../lib/errors.js'

const credentials = z.object({
  email: z.string().email('email 格式不正確').max(254),
  password: z.string().min(8, '密碼至少 8 個字元').max(200),
})

const registerBody = credentials.extend({
  displayName: z.string().min(1, '請填寫顯示名稱').max(80),
  workspaceName: z.string().min(1).max(80).optional(),
})

export default async function authRoutes(app: FastifyInstance) {

  app.post('/auth/register', async (req, reply) => {
    if (!env.allowSelfRegistration) throw forbidden('本站已關閉自行註冊，請聯絡管理員邀請')
    const body = registerBody.parse(req.body)

    if (env.allowedEmailDomains.length) {
      const domain = body.email.split('@')[1]?.toLowerCase() ?? ''
      if (!env.allowedEmailDomains.includes(domain)) {
        throw forbidden(`只開放這些網域註冊：${env.allowedEmailDomains.join(', ')}`)
      }
    }

    const exists = await sql`SELECT 1 FROM app_user WHERE email = ${body.email}`
    if (exists.length) throw badRequest('這個 email 已經註冊過了')

    const passwordHash = await hashPassword(body.password)

    const result = await sql.begin(async tx => {
      const [user] = await tx<{ id: string; email: string; display_name: string }[]>`
        INSERT INTO app_user (email, password_hash, display_name, status, email_verified_at)
        VALUES (${body.email}, ${passwordHash}, ${body.displayName}, 'ACTIVE', now())
        RETURNING id, email, display_name`

      // 沒有任何工作區時，第一個註冊者自動成為 OWNER 並完成初始化。
      // 自架情境下這比「先跑 CLI 建管理員」友善太多。
      const [{ count }] = await tx<{ count: string }[]>`SELECT count(*) FROM workspace`
      const isFirst = Number(count) === 0

      let workspaceId: string | null = null
      if (isFirst || body.workspaceName) {
        const name = body.workspaceName ?? `${body.displayName} 的工作區`
        const slug = `ws-${Math.random().toString(36).slice(2, 8)}`
        const [ws] = await tx<{ id: string }[]>`
          INSERT INTO workspace (slug, name) VALUES (${slug}, ${name}) RETURNING id`
        workspaceId = ws.id
        await tx`INSERT INTO workspace_member (workspace_id, user_id, role)
                 VALUES (${ws.id}, ${user.id}, 'OWNER')`
      } else {
        // 單一組織自架：後續註冊者自動加入既有工作區當 MEMBER
        const [ws] = await tx<{ id: string }[]>`SELECT id FROM workspace ORDER BY created_at LIMIT 1`
        if (ws) {
          workspaceId = ws.id
          await tx`INSERT INTO workspace_member (workspace_id, user_id, role)
                   VALUES (${ws.id}, ${user.id}, 'MEMBER')`
        }
      }
      return { user, workspaceId, isFirst }
    })

    const authUser = {
      id: result.user.id, email: result.user.email, displayName: result.user.display_name,
    }
    const accessToken = await signAccessToken(authUser)
    const { raw, hash } = newRefreshToken()
    await sql`
      INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at)
      VALUES (${authUser.id}, uuidv7(), ${hash},
              now() + ${env.refreshTtlSec + ' seconds'}::interval)`

    setRefreshCookie(reply, raw)
    return reply.code(201).send({
      accessToken, user: authUser,
      workspaceId: result.workspaceId, isFirstUser: result.isFirst,
    })
  })

  app.post('/auth/login', async (req, reply) => {
    const body = credentials.parse(req.body)
    const [row] = await sql<{
      id: string; email: string; display_name: string; password_hash: string | null; status: string
    }[]>`SELECT id, email, display_name, password_hash, status FROM app_user WHERE email = ${body.email}`

    // 帳號不存在時也跑一次雜湊，避免用回應時間差探測哪些 email 已註冊
    const ok = await verifyPassword(body.password, row?.password_hash ?? null)
    if (!row || !ok) throw unauthorized('email 或密碼錯誤')
    if (row.status !== 'ACTIVE') throw forbidden('帳號尚未啟用或已被停用')

    const user = { id: row.id, email: row.email, displayName: row.display_name }
    const accessToken = await signAccessToken(user)
    const { raw, hash } = newRefreshToken()
    await sql`
      INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at)
      VALUES (${user.id}, uuidv7(), ${hash}, now() + ${env.refreshTtlSec + ' seconds'}::interval)`

    setRefreshCookie(reply, raw)
    return { accessToken, user }
  })

  app.post('/auth/refresh', async (req, reply) => {
    const raw = (req.cookies as Record<string, string | undefined>)?.pmflow_rt
    if (!raw) throw unauthorized('沒有 refresh token')
    const hash = hashRefreshToken(raw)

    const [tok] = await sql<{
      id: string; user_id: string; family_id: string; revoked_at: string | null; expired: boolean
    }[]>`
      SELECT id, user_id, family_id, revoked_at, (expires_at < now()) AS expired
      FROM refresh_token WHERE token_hash = ${hash}`
    if (!tok) throw unauthorized('refresh token 無效')

    // Reuse detection：已撤銷的 token 又被拿來用 → 整個 family 一起撤銷。
    // 這代表 token 很可能外洩了，寧可讓使用者重登也不能繼續發新的。
    if (tok.revoked_at) {
      await sql`UPDATE refresh_token SET revoked_at = now()
                WHERE family_id = ${tok.family_id} AND revoked_at IS NULL`
      throw unauthorized('偵測到 token 重複使用，已撤銷所有登入，請重新登入')
    }
    if (tok.expired) throw unauthorized('登入已過期，請重新登入')

    const [u] = await sql<{ id: string; email: string; display_name: string }[]>`
      SELECT id, email, display_name FROM app_user WHERE id = ${tok.user_id} AND status = 'ACTIVE'`
    if (!u) throw unauthorized('帳號不存在或已停用')

    const next = newRefreshToken()
    await sql.begin(async tx => {
      await tx`UPDATE refresh_token SET revoked_at = now() WHERE id = ${tok.id}`
      await tx`INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at)
               VALUES (${u.id}, ${tok.family_id}, ${next.hash},
                       now() + ${env.refreshTtlSec + ' seconds'}::interval)`
    })

    const user = { id: u.id, email: u.email, displayName: u.display_name }
    setRefreshCookie(reply, next.raw)
    return { accessToken: await signAccessToken(user), user }
  })

  app.post('/auth/logout', async (req, reply) => {
    const raw = (req.cookies as Record<string, string | undefined>)?.pmflow_rt
    if (raw) {
      await sql`UPDATE refresh_token SET revoked_at = now()
                WHERE token_hash = ${hashRefreshToken(raw)} AND revoked_at IS NULL`
    }
    reply.clearCookie('pmflow_rt', { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', async req => {
    const user = await authenticate(req)
    const workspaces = await sql`
      SELECT w.id, w.name, w.slug, m.role
      FROM workspace w
      JOIN workspace_member m ON m.workspace_id = w.id AND m.user_id = ${user.id}
      ORDER BY w.created_at`
    return { user, workspaces }
  })
}

function setRefreshCookie(reply: import('fastify').FastifyReply, raw: string) {
  reply.setCookie('pmflow_rt', raw, {
    httpOnly: true,          // JS 讀不到，XSS 偷不走
    sameSite: 'strict',
    secure: env.isProd,      // 本機 http 開發時不能設 secure，否則瀏覽器不送
    path: '/',
    maxAge: env.refreshTtlSec,
  })
}
