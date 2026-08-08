import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import {
  authenticate, hashPassword, verifyPassword,
  requireWorkspaceMember, requireWorkspaceAdmin, requireWorkspaceOwner,
  newApiToken, type WorkspaceRole,
} from '../lib/auth.js'
import { saveAvatar, readAvatar, removeAvatar } from '../lib/avatar.js'
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

const apiTokenBody = z.object({
  name: z.string().min(1, '請幫這把權杖取個名字').max(80),
  /** 日曆日，不帶時間。沒帶就是不會過期 */
  expiresOn: z.string().date().nullable().optional(),
})

/**
 * 一個人最多能同時擁有幾把權杖。
 * 不是資安限制，是為了逼人清掉不用的 —— 列表長到要捲動時，
 * 沒有人分得出哪一把還在用，撤銷就變成不敢做的事。
 */
const MAX_ACTIVE_TOKENS = 20

/**
 * 管理者開帳號、調角色時能選的範圍。
 * 管理者身分只有擁有者給得起（見 /admin/administrators），
 * 擁有者身分誰都給不了 —— 開站的人就是開站的人。
 */
const ROLES: WorkspaceRole[] = ['MEMBER', 'GUEST']

const adminCreateBody = z.object({
  workspaceId: z.string().uuid(),
  email: z.string().email('email 格式不正確').max(254),
  displayName: z.string().min(1, '請填寫顯示名稱').max(80),
  password: z.string().min(8, '密碼至少 8 個字元').max(200),
  role: z.enum(['MEMBER', 'GUEST']).default('MEMBER'),
})

const adminPatchBody = z.object({
  role: z.enum(['MEMBER', 'GUEST']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  displayName: z.string().min(1).max(80).optional(),
  /** 管理者代設的新密碼。使用者下次登入就用這組 */
  newPassword: z.string().min(8, '密碼至少 8 個字元').max(200).optional(),
})

/** 這個工作區還剩幾個沒被停用的管理者 */
async function activeAdminCount(workspaceId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n
    FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
    WHERE wm.workspace_id = ${workspaceId} AND wm.role = 'ADMIN' AND u.status = 'ACTIVE'`
  return Number(row.n)
}

export default async function accountRoutes(app: FastifyInstance) {

  // ── 自己的帳號 ────────────────────────────────────────
  app.get('/me/profile', async req => {
    const auth = await authenticate(req)
    const [row] = await sql<{
      id: string; email: string; displayName: string
      locale: string; timezone: string; createdAt: string; avatarFile: string | null
    }[]>`
      SELECT id, email, display_name AS "displayName", locale, timezone,
             created_at AS "createdAt", avatar_file AS "avatarFile"
      FROM app_user WHERE id = ${auth.id}`
    if (!row) throw notFound('找不到帳號')

    const workspaces = await sql<{ id: string; name: string; role: string }[]>`
      SELECT w.id, w.name, wm.role
      FROM workspace_member wm JOIN workspace w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${auth.id}
      ORDER BY w.created_at`
    return { user: row, workspaces }
  })

  // ── 頭像 ────────────────────────────────────────────
  /**
   * 上傳用 JSON 帶 data URL，不做 multipart（見 lib/avatar.ts 的說明）。
   * 前端會先把圖縮成 256 見方再送，所以正常情況只有幾十 KB。
   */
  app.put('/me/avatar', async req => {
    const auth = await authenticate(req)
    const { image } = z.object({ image: z.string().min(1).max(4_000_000) }).parse(req.body)

    const [old] = await sql<{ avatar_file: string | null }[]>`
      SELECT avatar_file FROM app_user WHERE id = ${auth.id}`
    const file = await saveAvatar(auth.id, image)
    await sql`UPDATE app_user SET avatar_file = ${file} WHERE id = ${auth.id}`
    await removeAvatar(old?.avatar_file ?? null)
    return { avatarFile: file }
  })

  app.delete('/me/avatar', async (req, reply) => {
    const auth = await authenticate(req)
    const [old] = await sql<{ avatar_file: string | null }[]>`
      SELECT avatar_file FROM app_user WHERE id = ${auth.id}`
    await sql`UPDATE app_user SET avatar_file = NULL WHERE id = ${auth.id}`
    await removeAvatar(old?.avatar_file ?? null)
    return reply.code(204).send()
  })

  /**
   * 讀別人的頭像。
   *
   * 只要是同一個工作區的成員就看得到 —— 頭像會出現在任務清單、成員頁、
   * 通知裡，那些地方本來就看得到這個人的名字，頭像不比名字更私密。
   * 快取一小時，但檔名帶時間戳，換過就是新網址，不會拿到舊圖。
   */
  app.get<{ Params: { id: string } }>('/users/:id/avatar', async (req, reply) => {
    await authenticate(req)
    const [row] = await sql<{ avatar_file: string | null }[]>`
      SELECT avatar_file FROM app_user WHERE id = ${req.params.id}`
    if (!row?.avatar_file) throw notFound('這個帳號沒有頭像')
    const img = await readAvatar(row.avatar_file)
    if (!img) throw notFound('找不到頭像檔')
    return reply
      .header('cache-control', 'private, max-age=3600')
      .type(img.mime)
      .send(img.body)
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

  // ── 擁有者：只能決定誰是管理者 ─────────────────────────
  /**
   * 擁有者看得到的名單。**刻意只回名字、email 與「是不是管理者」** ——
   * 擁有者的職權只剩下指派管理者，帳號狀態、參與幾個專案這些細節不該讓他看。
   */
  app.get<{ Querystring: { workspaceId?: string } }>('/admin/administrators', async req => {
    const auth = await authenticate(req)
    const workspaceId = req.query.workspaceId
    if (!workspaceId) throw badRequest('缺少 workspaceId')
    await requireWorkspaceOwner(auth.id, workspaceId)

    const users = await sql`
      SELECT u.id, u.display_name AS "displayName", u.email,
             (wm.role = 'ADMIN') AS "isAdmin", (wm.role = 'OWNER') AS "isOwner"
      FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${workspaceId} AND u.status = 'ACTIVE'
      ORDER BY CASE wm.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,
               u.display_name`
    return { users }
  })

  /**
   * 指派或取消管理者。擁有者專用，而且是他唯一還能對別人的帳號做的事。
   *
   * 這一條存在的理由是解死結：管帳號的權力全給了管理者，那第一個管理者由誰指派？
   * 沒有這條，最後一個管理者離職之後整個站就再也沒有人能開帳號了。
   */
  app.put<{ Params: { userId: string }; Querystring: { workspaceId?: string } }>(
    '/admin/administrators/:userId', async req => {
      const auth = await authenticate(req)
      const workspaceId = req.query.workspaceId
      if (!workspaceId) throw badRequest('缺少 workspaceId')
      await requireWorkspaceOwner(auth.id, workspaceId)
      const { isAdmin } = z.object({ isAdmin: z.boolean() }).parse(req.body)
      const target = req.params.userId

      const [cur] = await sql<{ role: string }[]>`
        SELECT role FROM workspace_member
        WHERE workspace_id = ${workspaceId} AND user_id = ${target}`
      if (!cur) throw notFound('這個工作區裡沒有這個帳號')
      // 擁有者不能把自己變成管理者來繞過上面那條規矩
      if (target === auth.id) throw forbidden('不能指派自己當管理者')
      if (cur.role === 'OWNER') throw forbidden('擁有者不需要再被指派為管理者')

      await sql`UPDATE workspace_member SET role = ${isAdmin ? 'ADMIN' : 'MEMBER'}
                WHERE workspace_id = ${workspaceId} AND user_id = ${target}`
      return { ok: true }
    })

  // ── 自己的 API 權杖 ──────────────────────────────────
  /**
   * 給外部系統用的長期憑證。權限沿用發權杖的人 —— 拿權杖呼叫任何既有端點
   * （建任務、查清單…）跟本人操作沒有差別，驗證那一段在 lib/auth.ts。
   *
   * 明文只在建立當下回傳一次，資料庫裡只有 sha256 雜湊，之後任何人都看不回來
   * （包含站台管理者、包含資料庫備份的人）。使用者弄丟了就重發一把 ——
   * 這比「隨時查得到明文」安全得多，代價只是重設一次整合設定。
   */
  app.get('/me/api-tokens', async req => {
    const auth = await authenticate(req)
    // 回日曆日而不是那個時間點：使用者填的是「用到哪一天」，
    // 直接回 expires_at 會顯示成隔天，看起來像系統多給了一天
    const tokens = await sql`
      SELECT id, name, prefix,
             created_at AS "createdAt", last_used_at AS "lastUsedAt",
             to_char(expires_at - interval '1 day', 'YYYY-MM-DD') AS "expiresOn"
      FROM api_token
      WHERE user_id = ${auth.id} AND revoked_at IS NULL
      ORDER BY created_at DESC`
    return { tokens }
  })

  app.post('/me/api-tokens', async (req, reply) => {
    const auth = await authenticate(req)
    const body = apiTokenBody.parse(req.body)

    const [{ n }] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM api_token
      WHERE user_id = ${auth.id} AND revoked_at IS NULL`
    if (Number(n) >= MAX_ACTIVE_TOKENS) {
      throw badRequest(`最多只能同時擁有 ${MAX_ACTIVE_TOKENS} 把權杖，請先撤銷不用的`)
    }

    const token = newApiToken()
    // 到期日給的是日曆日，存成「那一天結束」—— 使用者選 8/31 的意思是
    // 「8/31 當天還能用」，存成 8/31 00:00 會讓它整整少一天。
    const [row] = await sql<{
      id: string; name: string; prefix: string
      createdAt: string; lastUsedAt: string | null; expiresOn: string | null
    }[]>`
      INSERT INTO api_token (user_id, name, token_hash, prefix, expires_at)
      VALUES (${auth.id}, ${body.name}, ${token.hash}, ${token.prefix},
              ${body.expiresOn ? sql`(${body.expiresOn}::date + interval '1 day')` : null})
      RETURNING id, name, prefix, created_at AS "createdAt",
                last_used_at AS "lastUsedAt",
                to_char(expires_at - interval '1 day', 'YYYY-MM-DD') AS "expiresOn"`

    // plaintext 只有這一次會出現在回應裡
    return reply.code(201).send({ token: row, plaintext: token.raw })
  })

  app.delete<{ Params: { id: string } }>('/me/api-tokens/:id', async (req, reply) => {
    const auth = await authenticate(req)
    // 只能撤自己的。條件寫在 UPDATE 裡，撤不到就是沒有這把
    const rows = await sql`
      UPDATE api_token SET revoked_at = now()
      WHERE id = ${req.params.id} AND user_id = ${auth.id} AND revoked_at IS NULL
      RETURNING id`
    if (!rows.length) throw notFound('找不到這把權杖，或它已經被撤銷了')
    return reply.code(204).send()
  })

  // ── 管理者/成員測試：工作區裡的帳號 ─────────────────────────────
  app.get<{ Querystring: { workspaceId?: string } }>('/admin/users', async req => {
    const auth = await authenticate(req)
    let workspaceId = req.query.workspaceId
    if (!workspaceId) {
      const [firstWs] = await sql<{ workspace_id: string }[]>`
        SELECT workspace_id FROM workspace_member WHERE user_id = ${auth.id} LIMIT 1`
      if (!firstWs) throw badRequest('缺少 workspaceId')
      workspaceId = firstWs.workspace_id
    }
    const { role } = await requireWorkspaceMember(auth.id, workspaceId)

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
    await requireWorkspaceAdmin(auth.id, body.workspaceId)

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
      await requireWorkspaceAdmin(auth.id, workspaceId)
      const body = adminPatchBody.parse(req.body)
      const target = req.params.userId

      const [cur] = await sql<{ role: string; status: string }[]>`
        SELECT wm.role, u.status
        FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
        WHERE wm.workspace_id = ${workspaceId} AND wm.user_id = ${target}`
      if (!cur) throw notFound('這個工作區裡沒有這個帳號')

      // 擁有者的帳號管理者一概碰不得 —— 他是這個站最後回得來的人，
      // 而管理者是他指派的，被指派的人不該反過來停掉指派他的人
      if (cur.role === 'OWNER') throw forbidden('擁有者的帳號不能由管理者調整')
      // 管理者之間互相不能改角色 —— 誰是管理者只有擁有者說了算
      if (cur.role === 'ADMIN' && body.role) {
        throw forbidden('管理者的身分只有擁有者能取消')
      }
      // 自己不能把自己降級或停用 —— 手滑就登不回來了
      if (target === auth.id && (body.role || body.status === 'SUSPENDED')) {
        throw badRequest('不能修改自己的角色或停用自己的帳號')
      }
      // 站台至少要留一個管得動帳號的人
      const losingAdmin = cur.role === 'ADMIN' && body.status === 'SUSPENDED'
      if (losingAdmin && (await activeAdminCount(workspaceId)) <= 1) {
        throw badRequest('這是最後一個管理者，停用之後就沒有人能管帳號了')
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

  /**
   * 真的把帳號刪掉。
   *
   * **停用與刪除是兩件事**：停用是「這個人先別進來」，資料都還在、隨時可以放回來；
   * 刪除是「這個人不該再出現在名單上」。只有後者能讓離職的同事從指派名單裡消失。
   *
   * 他建立過的專案會轉給執行刪除的管理者 —— 專案的建立者是「誰能決定成員」的依據
   * （見 routes/members.ts），沒有建立者的專案沒有人能再放人進來。
   * 任務的負責人、留言者這些欄位會變成空的（資料庫的外鍵設定就是這樣），
   * 任務本身不會跟著不見。
   */
  app.delete<{ Params: { userId: string }; Querystring: { workspaceId?: string } }>(
    '/admin/users/:userId', async req => {
      const auth = await authenticate(req)
      const workspaceId = req.query.workspaceId
      if (!workspaceId) throw badRequest('缺少 workspaceId')
      await requireWorkspaceAdmin(auth.id, workspaceId)
      const target = req.params.userId

      // 自己不能刪自己 —— 手滑就沒有帳號了，而且刪到最後一個管理者就沒人能管帳號
      if (target === auth.id) throw badRequest('不能刪除自己的帳號')

      const [cur] = await sql<{ role: string; avatar_file: string | null }[]>`
        SELECT wm.role, u.avatar_file
        FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
        WHERE wm.workspace_id = ${workspaceId} AND wm.user_id = ${target}`
      if (!cur) throw notFound('這個工作區裡沒有這個帳號')
      if (cur.role === 'OWNER') throw forbidden('擁有者的帳號不能刪除')
      // 先請擁有者取消他的管理者身分，再刪 —— 免得管理者互刪
      if (cur.role === 'ADMIN') {
        throw forbidden('要先請擁有者取消他的管理者身分，才能刪除這個帳號')
      }

      // 帳號是整站共用的，不是只屬於這個工作區。人還在別的工作區裡就不該從這裡刪掉
      const [{ n: elsewhere }] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM workspace_member
        WHERE user_id = ${target} AND workspace_id <> ${workspaceId}`
      if (Number(elsewhere) > 0) {
        throw badRequest('這個帳號還在別的工作區裡，不能從這裡刪除')
      }

      const transferred = await sql.begin(async tx => {
        const moved = await tx`
          UPDATE project SET created_by = ${auth.id}
          WHERE workspace_id = ${workspaceId} AND created_by = ${target}
          RETURNING id`
        // 其他關聯由資料庫的外鍵處理：成員資格、登入憑證跟著刪，
        // 負責人、發問者這些欄位變成空的（見 0001_init.sql）
        await tx`DELETE FROM app_user WHERE id = ${target}`
        return moved.length
      })
      await removeAvatar(cur.avatar_file)

      return { ok: true, projectsTransferred: transferred }
    })
}
