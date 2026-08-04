import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import {
  authenticate, requireProjectCreator, requireProjectRole, requireWorkspaceMember,
} from '../lib/auth.js'
import { notify } from '../lib/notify.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'

/**
 * 專案成員與加入申請。
 *
 * 規則只有一條，其他都從它推出來：**專案是誰開的，誰才能決定誰進得來。**
 * 創立者可以直接把工作區裡的帳號放進來，也可以核准別人送來的申請；
 * 其他人只能申請，等創立者同意。
 *
 * 沒有做通知信 —— 系統目前沒有寄信的東西（那是 M4 最後一項）。
 * 待審的申請靠畫面上的數字提醒，不會有人收到信卻沒地方處理。
 */

const ROLES = ['MANAGER', 'EDITOR', 'COMMENTER', 'VIEWER'] as const

const addMemberBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(ROLES).default('EDITOR'),
})

const applyBody = z.object({
  message: z.string().max(500).optional(),
})

const decideBody = z.object({
  role: z.enum(ROLES).default('EDITOR'),
  note: z.string().max(500).optional(),
})

export default async function memberRoutes(app: FastifyInstance) {

  // ── 可以申請加入的專案 ────────────────────────────────
  /**
   * 同工作區、自己還不是成員的專案。只回專案本身的門面資訊
   * （代碼、名稱、誰開的、多少人），不回任何任務內容 ——
   * 還沒獲准的人不該看到裡面有什麼。
   *
   * **要搜尋才回東西**（`q` 比對專案名稱或代碼）。原本是把整個工作區的專案
   * 都列出來，但「預設就看得到每一個專案叫什麼、誰開的」本身就是一種外洩 ——
   * 專案名稱常常寫著客戶名或標案名。要加入的人本來就知道自己要找哪一個，
   * 讓他打出來即可。
   *
   * 唯一的例外是自己還在審核中的申請：那些一律回，否則送出去之後就找不到
   * 那張卡片，也就撤不回來了。
   */
  app.get<{ Querystring: { workspaceId?: string; q?: string } }>(
    '/projects/joinable', async req => {
      const user = await authenticate(req)
      const workspaceId = req.query.workspaceId
      if (!workspaceId) throw badRequest('缺少 workspaceId')
      await requireWorkspaceMember(user.id, workspaceId)

      const q = (req.query.q ?? '').trim()
      // 代碼是大寫英數，名稱是自由文字，所以兩邊比對方式不同：
      // 代碼從開頭比（打 MRG 是在找 MRG，不是找 XMRG），名稱包含就算
      const like = `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      const keyLike = `${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

      const rows = await sql`
      SELECT p.id, p.key, p.name, p.description, p.color,
             u.display_name AS "createdByName",
             (SELECT count(*) FROM project_member m WHERE m.project_id = p.id)::int AS "memberCount",
             r.status AS "myRequestStatus",
             r.id     AS "myRequestId"
      FROM project p
      LEFT JOIN app_user u ON u.id = p.created_by
      LEFT JOIN project_join_request r
             ON r.project_id = p.id AND r.user_id = ${user.id} AND r.status = 'PENDING'
      WHERE p.workspace_id = ${workspaceId}
        AND p.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM project_member pm
          WHERE pm.project_id = p.id AND pm.user_id = ${user.id})
        AND (
          r.id IS NOT NULL
          OR (${q} <> '' AND (p.name ILIKE ${like} OR p.key ILIKE ${keyLike}))
        )
      ORDER BY r.id IS NULL, p.rank, p.created_at
      LIMIT 30`
      return { projects: rows }
    })

  // ── 工作區裡有哪些帳號 ────────────────────────────────
  /**
   * 創立者要「直接把某個帳號放進專案」時，總得先選人。
   * 只回同工作區的帳號，而且只回名字與信箱 —— 這是同一個組織內部彼此看得到的程度。
   */
  app.get<{ Querystring: { workspaceId?: string } }>('/workspace-users', async req => {
    const user = await authenticate(req)
    const workspaceId = req.query.workspaceId
    if (!workspaceId) throw badRequest('缺少 workspaceId')
    await requireWorkspaceMember(user.id, workspaceId)

    const rows = await sql`
      SELECT u.id, u.display_name AS "displayName", u.email, wm.role
      FROM workspace_member wm
      JOIN app_user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${workspaceId}
      ORDER BY u.display_name`
    return { users: rows }
  })

  // ── 成員清單 ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/projects/:id/members', async req => {
    const user = await authenticate(req)
    await requireProjectRole(user.id, req.params.id, 'VIEWER')
    const [p] = await sql<{ created_by: string | null }[]>`
      SELECT created_by FROM project WHERE id = ${req.params.id}`
    if (!p) throw notFound('找不到專案')

    const members = await sql`
      SELECT u.id, u.display_name AS "displayName", u.email, pm.role,
             (u.avatar_file IS NOT NULL) AS "hasAvatar",
             pm.joined_at AS "joinedAt"
      FROM project_member pm
      JOIN app_user u ON u.id = pm.user_id
      WHERE pm.project_id = ${req.params.id}
      ORDER BY u.display_name`
    return {
      members: members.map(m => ({ ...m, isCreator: m.id === p.created_by })),
      createdBy: p.created_by,
      canManage: p.created_by === user.id,
    }
  })

  /** 創立者直接把工作區裡的帳號放進來，不必等對方申請 */
  app.post<{ Params: { id: string } }>('/projects/:id/members', async (req, reply) => {
    const user = await authenticate(req)
    const { workspaceId } = await requireProjectCreator(user.id, req.params.id)
    const body = addMemberBody.parse(req.body)

    await requireWorkspaceMember(body.userId, workspaceId)
      .catch(() => { throw badRequest('這個帳號不在同一個工作區，不能加入專案') })

    const exists = await sql`
      SELECT 1 FROM project_member
      WHERE project_id = ${req.params.id} AND user_id = ${body.userId}`
    if (exists.length) throw conflict('這個帳號已經是專案成員了')

    await sql.begin(async tx => {
      await tx`
        INSERT INTO project_member (project_id, user_id, role, added_by)
        VALUES (${req.params.id}, ${body.userId}, ${body.role}, ${user.id})`
      // 直接放進來的話，他自己送的申請就沒有意義了，一併結掉免得留在待審清單
      await tx`
        UPDATE project_join_request
        SET status = 'APPROVED', decided_by = ${user.id}, decided_at = now(),
            decided_note = '已由建立者直接加入'
        WHERE project_id = ${req.params.id} AND user_id = ${body.userId} AND status = 'PENDING'`

      // 被直接加進來的人不會知道自己多了一個專案，這一則就是他唯一的線索
      await notify({
        db: tx, workspaceId, userId: body.userId,
        kind: 'JOIN_APPROVED', actorId: user.id, actorName: user.displayName,
        projectId: req.params.id, body: { role: body.role, direct: true },
      })
    })
    return reply.code(201).send({ ok: true })
  })

  app.patch<{ Params: { id: string; userId: string } }>(
    '/projects/:id/members/:userId', async req => {
      const user = await authenticate(req)
      await requireProjectCreator(user.id, req.params.id)
      const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body)

      const [p] = await sql<{ created_by: string | null }[]>`
        SELECT created_by FROM project WHERE id = ${req.params.id}`
      if (p?.created_by === req.params.userId) {
        throw badRequest('不能改建立者自己的角色')
      }
      const rows = await sql`
        UPDATE project_member SET role = ${role}
        WHERE project_id = ${req.params.id} AND user_id = ${req.params.userId}
        RETURNING user_id AS "userId", role`
      if (!rows.length) throw notFound('這個帳號不是專案成員')
      return rows[0]
    })

  app.delete<{ Params: { id: string; userId: string } }>(
    '/projects/:id/members/:userId', async (req, reply) => {
      const user = await authenticate(req)
      await requireProjectCreator(user.id, req.params.id)

      const [p] = await sql<{ created_by: string | null }[]>`
        SELECT created_by FROM project WHERE id = ${req.params.id}`
      // 移掉創立者等於專案沒人能管成員了，擋掉
      if (p?.created_by === req.params.userId) {
        throw badRequest('不能把專案的建立者移出專案')
      }
      const rows = await sql`
        DELETE FROM project_member
        WHERE project_id = ${req.params.id} AND user_id = ${req.params.userId}
        RETURNING user_id`
      if (!rows.length) throw notFound('這個帳號不是專案成員')
      return reply.code(204).send()
    })

  // ── 申請加入 ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/projects/:id/join-requests', async (req, reply) => {
    const user = await authenticate(req)
    const body = applyBody.parse(req.body)

    const [p] = await sql<{
      workspace_id: string; archived_at: string | null; created_by: string | null
    }[]>`
      SELECT workspace_id, archived_at, created_by FROM project WHERE id = ${req.params.id}`
    if (!p) throw notFound('找不到專案')
    if (p.archived_at) throw badRequest('這個專案已封存，不能申請加入')
    await requireWorkspaceMember(user.id, p.workspace_id)

    const already = await sql`
      SELECT 1 FROM project_member
      WHERE project_id = ${req.params.id} AND user_id = ${user.id}`
    if (already.length) throw conflict('你已經是這個專案的成員了')

    // 同時只能有一筆待審：DB 有部分唯一索引擋著，這裡先問一次好給中文訊息
    const pending = await sql`
      SELECT 1 FROM project_join_request
      WHERE project_id = ${req.params.id} AND user_id = ${user.id} AND status = 'PENDING'`
    if (pending.length) throw conflict('你已經送出申請了，正在等建立者處理')

    const [row] = await sql`
      INSERT INTO project_join_request (project_id, user_id, message)
      VALUES (${req.params.id}, ${user.id}, ${body.message ?? null})
      RETURNING id, status, created_at AS "createdAt"`

    // 創立者得知道有人在敲門。「成員」頁籤上的紅點只有進到那個專案才看得到，
    // 而會來申請的多半是創立者近期沒在看的專案。
    await notify({
      db: sql, workspaceId: p.workspace_id, userId: p.created_by,
      kind: 'JOIN_REQUESTED', actorId: user.id, actorName: user.displayName,
      projectId: req.params.id, body: { message: body.message ?? null },
    })
    return reply.code(201).send(row)
  })

  /** 待審清單。只有創立者看得到誰想進來。 */
  app.get<{ Params: { id: string } }>('/projects/:id/join-requests', async req => {
    const user = await authenticate(req)
    await requireProjectCreator(user.id, req.params.id)
    const rows = await sql`
      SELECT r.id, r.message, r.status, r.created_at AS "createdAt",
             u.id AS "userId", u.display_name AS "displayName", u.email
      FROM project_join_request r
      JOIN app_user u ON u.id = r.user_id
      WHERE r.project_id = ${req.params.id} AND r.status = 'PENDING'
      ORDER BY r.created_at`
    return { requests: rows }
  })

  /** 自己送出去的申請，用來在畫面上顯示「審核中」 */
  app.get('/join-requests/mine', async req => {
    const user = await authenticate(req)
    const rows = await sql`
      SELECT r.id, r.status, r.message, r.decided_note AS "decidedNote",
             r.created_at AS "createdAt", r.decided_at AS "decidedAt",
             p.id AS "projectId", p.key AS "projectKey", p.name AS "projectName"
      FROM project_join_request r
      JOIN project p ON p.id = r.project_id
      WHERE r.user_id = ${user.id}
      ORDER BY r.created_at DESC
      LIMIT 50`
    return { requests: rows }
  })

  app.post<{ Params: { id: string; reqId: string } }>(
    '/projects/:id/join-requests/:reqId/approve', async req => {
      const user = await authenticate(req)
      const { workspaceId } = await requireProjectCreator(user.id, req.params.id)
      const body = decideBody.parse(req.body ?? {})

      return sql.begin(async tx => {
        // FOR UPDATE：同一筆申請被連點兩次時，第二次會等第一次寫完再讀，
        // 讀到的已經是 APPROVED，就不會重覆加人
        const [r] = await tx<{ user_id: string; status: string }[]>`
          SELECT user_id, status FROM project_join_request
          WHERE id = ${req.params.reqId} AND project_id = ${req.params.id}
          FOR UPDATE`
        if (!r) throw notFound('找不到這筆申請')
        if (r.status !== 'PENDING') throw conflict('這筆申請已經處理過了')

        await tx`
          INSERT INTO project_member (project_id, user_id, role, added_by)
          VALUES (${req.params.id}, ${r.user_id}, ${body.role}, ${user.id})
          ON CONFLICT (project_id, user_id) DO NOTHING`
        await tx`
          UPDATE project_join_request
          SET status = 'APPROVED', decided_by = ${user.id}, decided_at = now(),
              decided_note = ${body.note ?? null}
          WHERE id = ${req.params.reqId}`

        await notify({
          db: tx, workspaceId, userId: r.user_id,
          kind: 'JOIN_APPROVED', actorId: user.id, actorName: user.displayName,
          projectId: req.params.id, body: { role: body.role, note: body.note ?? null },
        })
        return { ok: true, role: body.role }
      })
    })

  app.post<{ Params: { id: string; reqId: string } }>(
    '/projects/:id/join-requests/:reqId/reject', async req => {
      const user = await authenticate(req)
      await requireProjectCreator(user.id, req.params.id)
      const body = decideBody.partial().parse(req.body ?? {})

      const rows = await sql`
        UPDATE project_join_request
        SET status = 'REJECTED', decided_by = ${user.id}, decided_at = now(),
            decided_note = ${body.note ?? null}
        WHERE id = ${req.params.reqId} AND project_id = ${req.params.id} AND status = 'PENDING'
        RETURNING id`
      if (!rows.length) throw conflict('找不到待處理的申請，可能已經處理過了')
      return { ok: true }
    })

  /** 申請人自己撤回 */
  app.delete<{ Params: { reqId: string } }>('/join-requests/:reqId', async (req, reply) => {
    const user = await authenticate(req)
    const rows = await sql`
      UPDATE project_join_request
      SET status = 'CANCELLED', decided_at = now()
      WHERE id = ${req.params.reqId} AND user_id = ${user.id} AND status = 'PENDING'
      RETURNING id`
    if (!rows.length) throw forbidden('找不到你的待審申請')
    return reply.code(204).send()
  })
}
