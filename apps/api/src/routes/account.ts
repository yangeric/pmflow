import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import {
  authenticate, hashPassword, verifyPassword, requireWorkspaceAdmin, type WorkspaceRole,
} from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'

/**
 * 帳號自己的設定，以及工作區管理者對帳號的管理。
 *
 * 兩件事放同一個檔，因為它們共用同一張表與同一套規則：
 * **自己能改自己的名字與密碼；管理者能開帳號、停用帳號、調整工作區角色，
 * 但改不了別人的密碼以外的東西，也改不了別人的 email。**
 *
 * 站台一定要留得下一個 OWNER —— 最後一個 OWNER 不能被降級、不能被停用，
 * 否則沒有人能再管理帳號，自架的站就只能進資料庫救。
 */

const profileBody = z.object({
  displayName: z.string().min(1, '請填寫顯示名稱').max(80).optional(),
  email: z.string().email('email 格式不正確').max(254).optional(),
})

const passwordBody = z.object({
  currentPassword: z.string().min(1, '請輸入目前的密碼').max(200),
  newPassword: z.string().min(8, '新密碼至少 8 個字元').max(200),
})

const ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST']

const adminCreateBody = z.object({
  workspaceId: z.string().uuid(),
  email: z.string().email('email 格式不正確').max(254),
  displayName: z.string().min(1, '請填寫顯示名稱').max(80),
  password: z.string().min(8, '密碼至少 8 個字元').max(200),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'GUEST']).default('MEMBER'),
})

const adminPatchBody = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'GUEST']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  displayName: z.string().min(1).max(80).optional(),
  /** 管理者代設的新密碼。使用者下次登入就用這組 */
  newPassword: z.string().min(8, '密碼至少 8 個字元').max(200).optional(),
})

/** 這個工作區還剩幾個沒被停用的 OWNER */
async function activeOwnerCount(workspaceId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n
    FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
    WHERE wm.workspace_id = ${workspaceId} AND wm.role = 'OWNER' AND u.status = 'ACTIVE'`
  return Number(row.n)
}

export default async function accountRoutes(app: FastifyInstance) {

  // ── 自己的帳號 ────────────────────────────────────────
  app.get('/me/profile', async req => {
    const auth = await authenticate(req)
    const [row] = await sql<{
      id: string; email: string; displayName: string
      locale: string; timezone: string; createdAt: string
    }[]>`
      SELECT id, email, display_name AS "displayName", locale, timezone,
             created_at AS "createdAt"
      FROM app_user WHERE id = ${auth.id}`
    if (!row) throw notFound('找不到帳號')

    const workspaces = await sql<{ id: string; name: string; role: string }[]>`
      SELECT w.id, w.name, wm.role
      FROM workspace_member wm JOIN workspace w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${auth.id}
      ORDER BY w.created_at`
    return { user: row, workspaces }
  })

  app.patch('/me/profile', async req => {
    const auth = await authenticate(req)
    const body = profileBody.parse(req.body)
    if (body.email === undefined && body.displayName === undefined) {
      throw badRequest('沒有要修改的欄位')
    }

    if (body.email) {
      const dup = await sql`
        SELECT 1 FROM app_user WHERE email = ${body.email} AND id <> ${auth.id}`
      if (dup.length) throw conflict('這個 email 已經有人用了')
    }

    // COALESCE 讓「只改名字」跟「只改 email」共用同一句，沒帶到的欄位保持原值
    const [row] = await sql<{ id: string; email: string; displayName: string }[]>`
      UPDATE app_user SET
        display_name = COALESCE(${body.displayName ?? null}, display_name),
        email        = COALESCE(${body.email ?? null}, email)
      WHERE id = ${auth.id}
      RETURNING id, email, display_name AS "displayName"`
    return { user: row }
  })

  app.post('/me/password', async req => {
    const auth = await authenticate(req)
    const body = passwordBody.parse(req.body)

    const [row] = await sql<{ password_hash: string | null }[]>`
      SELECT password_hash FROM app_user WHERE id = ${auth.id}`
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw forbidden('目前的密碼不對')
    }

    const hash = await hashPassword(body.newPassword)
    await sql.begin(async tx => {
      await tx`UPDATE app_user SET password_hash = ${hash} WHERE id = ${auth.id}`
      // 改完密碼把其他裝置的登入一起踢掉 —— 會改密碼通常就是覺得被別人知道了
      await tx`UPDATE refresh_token SET revoked_at = now()
               WHERE user_id = ${auth.id} AND revoked_at IS NULL`
    })
    return { ok: true }
  })

  // ── 管理者：工作區裡的帳號 ─────────────────────────────
  app.get<{ Querystring: { workspaceId?: string } }>('/admin/users', async req => {
    const auth = await authenticate(req)
    const workspaceId = req.query.workspaceId
    if (!workspaceId) throw badRequest('缺少 workspaceId')
    const { role } = await requireWorkspaceAdmin(auth.id, workspaceId)

    const users = await sql`
      SELECT u.id, u.email, u.display_name AS "displayName", u.status,
             wm.role, wm.joined_at AS "joinedAt",
             (SELECT count(*) FROM project_member pm
              JOIN project p ON p.id = pm.project_id AND p.workspace_id = ${workspaceId}
              WHERE pm.user_id = u.id) AS "projectCount",
             (SELECT count(*) FROM project p
              WHERE p.workspace_id = ${workspaceId} AND p.created_by = u.id) AS "createdCount"
      FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${workspaceId}
      ORDER BY CASE wm.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1
                            WHEN 'MEMBER' THEN 2 ELSE 3 END, u.display_name`
    return { users, myRole: role, roles: ROLES }
  })

  app.post('/admin/users', async (req, reply) => {
    const auth = await authenticate(req)
    const body = adminCreateBody.parse(req.body)
    const { role: myRole } = await requireWorkspaceAdmin(auth.id, body.workspaceId)
    // ADMIN 開得出 ADMIN 以下，OWNER 才給得出 OWNER
    if (body.role === 'OWNER' && myRole !== 'OWNER') {
      throw forbidden('只有 OWNER 可以指派另一個 OWNER')
    }

    const dup = await sql`SELECT 1 FROM app_user WHERE email = ${body.email}`
    if (dup.length) throw conflict('這個 email 已經註冊過了')

    const hash = await hashPassword(body.password)
    const user = await sql.begin(async tx => {
      const [u] = await tx<{ id: string; email: string; displayName: string }[]>`
        INSERT INTO app_user (email, password_hash, display_name, status, email_verified_at)
        VALUES (${body.email}, ${hash}, ${body.displayName}, 'ACTIVE', now())
        RETURNING id, email, display_name AS "displayName"`
      await tx`INSERT INTO workspace_member (workspace_id, user_id, role)
               VALUES (${body.workspaceId}, ${u.id}, ${body.role})`
      return u
    })
    // 沒有寄信的機制，密碼是管理者當面給的 —— 這一點前端要講清楚
    return reply.code(201).send({ user })
  })

  app.patch<{ Params: { userId: string }; Querystring: { workspaceId?: string } }>(
    '/admin/users/:userId', async req => {
      const auth = await authenticate(req)
      const workspaceId = req.query.workspaceId
      if (!workspaceId) throw badRequest('缺少 workspaceId')
      const { role: myRole } = await requireWorkspaceAdmin(auth.id, workspaceId)
      const body = adminPatchBody.parse(req.body)
      const target = req.params.userId

      const [cur] = await sql<{ role: string; status: string }[]>`
        SELECT wm.role, u.status
        FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
        WHERE wm.workspace_id = ${workspaceId} AND wm.user_id = ${target}`
      if (!cur) throw notFound('這個工作區裡沒有這個帳號')

      if (body.role === 'OWNER' && myRole !== 'OWNER') {
        throw forbidden('只有 OWNER 可以指派另一個 OWNER')
      }
      if (cur.role === 'OWNER' && myRole !== 'OWNER') {
        throw forbidden('只有 OWNER 可以調整另一個 OWNER')
      }
      // 自己不能把自己降級或停用 —— 手滑就登不回來了
      if (target === auth.id && (body.role || body.status === 'SUSPENDED')) {
        throw badRequest('不能修改自己的角色或停用自己的帳號')
      }
      // 站台至少要留一個能管事的人
      const losingOwner =
        cur.role === 'OWNER' && ((body.role && body.role !== 'OWNER') || body.status === 'SUSPENDED')
      if (losingOwner && (await activeOwnerCount(workspaceId)) <= 1) {
        throw badRequest('這是最後一個 OWNER，不能降級或停用')
      }

      await sql.begin(async tx => {
        if (body.role) {
          await tx`UPDATE workspace_member SET role = ${body.role}
                   WHERE workspace_id = ${workspaceId} AND user_id = ${target}`
        }
        if (body.status) {
          await tx`UPDATE app_user SET status = ${body.status} WHERE id = ${target}`
          if (body.status === 'SUSPENDED') {
            // 停用要立刻生效，不能等他手上那張 access token 過期
            await tx`UPDATE refresh_token SET revoked_at = now()
                     WHERE user_id = ${target} AND revoked_at IS NULL`
          }
        }
        if (body.displayName) {
          await tx`UPDATE app_user SET display_name = ${body.displayName} WHERE id = ${target}`
        }
        if (body.newPassword) {
          await tx`UPDATE app_user SET password_hash = ${await hashPassword(body.newPassword)}
                   WHERE id = ${target}`
          await tx`UPDATE refresh_token SET revoked_at = now()
                   WHERE user_id = ${target} AND revoked_at IS NULL`
        }
      })
      return { ok: true }
    })
}
