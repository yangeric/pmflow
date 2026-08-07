import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import {
  authenticate, requireProjectManager, requireProjectRole, requireWorkspaceMember,
} from '../lib/auth.js'
import { notify } from '../lib/notify.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'

/**
 * 專案成員與加入申請。
 *
 * 規則只有一條，其他都從它推出來：**這個專案的管理者才能決定誰進得來。**
 * 管理者可以搜尋任何一個帳號直接放進來，也可以核准別人送來的申請；
 * 其他人只能申請，等管理者同意。
 *
 * 開專案的人建立時就是管理者，所以「只有建立者能管成員」的舊行為完整包含在
 * 這條規則裡；差別只在於他可以再指定幾個人一起管。建立者本身仍有兩項保護：
 * 角色不能被改、不能被移出專案 —— 不然專案有機會變成沒有人管得動。
 *
 * 沒有做通知信 —— 系統目前沒有寄信的東西（那是 M4 最後一項）。
 * 待審的申請靠畫面上的數字提醒，不會有人收到信卻沒地方處理。
 */

const ROLES = ['MANAGER', 'EDITOR', 'COMMENTER', 'VIEWER'] as const

/**
 * 成員頁那兩份清單要的欄位。刻意比 tasks.ts 的 TASK_COLUMNS 少 ——
 * 那邊是任務本身的畫面，需要描述、工時、排程模式；這裡只是「他手上有哪些事」，
 * 一列看得到編號、標題、狀態、到期日、進度、對外詢問就夠了。
 * 少回的欄位不是省流量，是不要讓這個端點變成第二個任務查詢入口。
 */
const TASK_BRIEF = sql`
  t.id, p.key || '-' || t.number AS "ref", t.title, t.type,
  t.status_key AS "statusKey", t.progress,
  t.start_date AS "startDate", t.due_date AS "dueDate",
  t.inquiry_state AS "inquiryState",
  t.assignee_id AS "assigneeId", u.display_name AS "assigneeName",
  (u.avatar_file IS NOT NULL) AS "assigneeHasAvatar"`

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
      SELECT p.id, p.key, p.name, p.description, p.color, p.is_public AS "isPublic",
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
          -- 公開的專案不用搜尋就看得到；審核中的申請一律留著，不然撤不回來
          p.is_public
          OR r.id IS NOT NULL
          OR (${q} <> '' AND (p.name ILIKE ${like} OR p.key ILIKE ${keyLike}))
        )
      ORDER BY r.id IS NULL, p.is_public DESC, p.rank, p.created_at
      LIMIT 30`
      return { projects: rows }
    })

  // ── 可以放進專案的帳號 ────────────────────────────────
  /**
   * 管理者要「直接把某個帳號放進專案」時，總得先選人。
   *
   * 沒給 `q`：跟以前一樣，把同工作區的帳號整個列出來 —— 那是同一個組織內部
   * 彼此本來就看得到的名單，當成挑人的預設清單。
   *
   * 給了 `q`：**跨工作區**比對名字或 email（大小寫不拘、部分比對）。
   * 要找來一起做事的人不見得已經在這個工作區裡，找不到人就沒辦法請他進來。
   * 只回名字與信箱，跟上面那條路一樣 —— 而且要打得出名字或 email 才找得到，
   * 不會有人靠這個把全站的帳號撈成一份名單。
   *
   * 搜尋這條會擋掉停用與未啟用的帳號 —— 那些人登不進來，
   * 加進專案只會變成名單上一個永遠不會出現的名字。
   * 沒給 q 的那條刻意不加這個條件，才不會動到原本的回傳內容。
   */
  app.get<{ Querystring: { workspaceId?: string; q?: string; projectId?: string } }>(
    '/workspace-users', async req => {
      const user = await authenticate(req)
      const workspaceId = req.query.workspaceId
      if (!workspaceId) throw badRequest('缺少 workspaceId')
      await requireWorkspaceMember(user.id, workspaceId)

      const q = (req.query.q ?? '').trim()
      /**
       * 跨工作區的搜尋要指名「你是在幫哪個專案找人」，而且要是那個專案的管理者。
       *
       * 只驗「是這個工作區的成員」不夠：那等於任何人都能拿名字或 email 去試，
       * 一次一個字地問「這個帳號在不在這個站上」。真正需要跨工作區找人的
       * 只有正在加人的專案管理者，所以權限就綁在那件事上。
       * 沒給 q 的那條維持原樣（只列同工作區的人），別的畫面還在用。
       */
      if (q) {
        const projectId = req.query.projectId
        if (!projectId) throw badRequest('搜尋帳號要指定是哪個專案要加人')
        await requireProjectManager(user.id, projectId)
      }
      if (!q) {
        const rows = await sql`
          SELECT u.id, u.display_name AS "displayName", u.email, wm.role
          FROM workspace_member wm
          JOIN app_user u ON u.id = wm.user_id
          WHERE wm.workspace_id = ${workspaceId}
          ORDER BY u.display_name`
        return { users: rows }
      }

      // ILIKE 的萬用字元要跳脫，不然打一個 % 就等於把所有帳號列出來
      const like = `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      const rows = await sql`
        SELECT u.id, u.display_name AS "displayName", u.email,
               -- 不在這個工作區的人也找得到，這時沒有工作區角色可以回
               coalesce(wm.role, '') AS role
        FROM app_user u
        LEFT JOIN workspace_member wm
               ON wm.user_id = u.id AND wm.workspace_id = ${workspaceId}
        WHERE u.status = 'ACTIVE'
          AND (u.display_name ILIKE ${like} OR u.email ILIKE ${like})
        ORDER BY wm.role IS NULL, u.display_name
        LIMIT 30`
      return { users: rows }
    })

  // ── 成員清單 ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/projects/:id/members', async req => {
    const user = await authenticate(req)
    const { role } = await requireProjectRole(user.id, req.params.id, 'VIEWER')
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
      canManage: role === 'MANAGER',
    }
  })

  // ── 某個成員的任務：現在手上的、以及從他手上轉出去的 ──────
  /**
   * 成員頁右邊那兩區。**同專案的人都看得到**，不要求管理者 ——
   * 這是「誰在做什麼」，卡權限只會讓大家各自去問人。
   *
   * `current`：現在指派給他的全部，**不分狀態、含已完成** ——
   * 濾掉做完的會讓「他做過什麼」憑空少一半。
   *
   * `past`：**經手過、現在已經不在他身上**的。來源是轉派寫下的活動紀錄
   * （`POST /tasks/:id/reassign`，body 帶 `previousAssigneeId`），
   * 不是「已完成的任務」—— 做完的在清單頁篩狀態就看得到，
   * 「這張以前是誰在做」才是別的地方查不到的東西。
   *
   * 同一張任務可能轉來轉去好幾次，只取**最後一筆**（LATERAL + LIMIT 1）：
   * 那才是「他什麼時候把這件事交出去的」，中間那幾筆是別人之間的交接。
   * 「現在是誰負責」一律讀任務當下的負責人，不是活動紀錄裡的名字 ——
   * 他交出去之後可能又換過手，紀錄裡那個名字早就不是現在要找的人。
   */
  app.get<{ Params: { id: string; userId: string } }>(
    '/projects/:id/members/:userId/tasks', async req => {
      const user = await authenticate(req)
      await requireProjectRole(user.id, req.params.id, 'VIEWER')

      const current = await sql`
        SELECT ${TASK_BRIEF}
        FROM task t
        JOIN project p ON p.id = t.project_id
        LEFT JOIN app_user u ON u.id = t.assignee_id
        WHERE t.project_id = ${req.params.id} AND t.deleted_at IS NULL
          AND t.assignee_id = ${req.params.userId}
        ORDER BY t.rank, t.number`

      const past = await sql`
        SELECT ${TASK_BRIEF},
               -- 轉出的日子。時間戳在這裡沒有意義，也不該讓前端再轉一次時區，
               -- 直接照資料庫的時區格成 YYYY-MM-DD 字串交出去
               to_char(a.created_at, 'YYYY-MM-DD') AS "handedOverOn",
               a.body->>'note' AS "handoverNote"
        FROM task t
        JOIN project p ON p.id = t.project_id
        LEFT JOIN app_user u ON u.id = t.assignee_id
        JOIN LATERAL (
          SELECT ac.created_at, ac.body
          FROM activity ac
          WHERE ac.task_id = t.id
            AND ac.body->>'previousAssigneeId' = ${req.params.userId}
          ORDER BY ac.created_at DESC
          LIMIT 1
        ) a ON true
        WHERE t.project_id = ${req.params.id} AND t.deleted_at IS NULL
          -- 又轉回他身上的不算「曾經」，那張現在就在他手上，會出現在上面那一區
          AND t.assignee_id IS DISTINCT FROM ${req.params.userId}
        ORDER BY a.created_at DESC`

      return { current, past }
    })

  /** 管理者直接把某個帳號放進來，不必等對方申請 */
  app.post<{ Params: { id: string } }>('/projects/:id/members', async (req, reply) => {
    const user = await authenticate(req)
    const { workspaceId } = await requireProjectManager(user.id, req.params.id)
    const body = addMemberBody.parse(req.body)

    const [target] = await sql<{ status: string; ws: boolean }[]>`
      SELECT u.status,
             EXISTS (SELECT 1 FROM workspace_member wm
                      WHERE wm.workspace_id = ${workspaceId} AND wm.user_id = u.id) AS ws
      FROM app_user u WHERE u.id = ${body.userId}`
    if (!target) throw badRequest('找不到這個帳號')
    if (target.status !== 'ACTIVE') {
      throw badRequest('這個帳號現在登不進來（未啟用或已停用），不能加入專案')
    }

    const exists = await sql`
      SELECT 1 FROM project_member
      WHERE project_id = ${req.params.id} AND user_id = ${body.userId}`
    if (exists.length) throw conflict('這個帳號已經是專案成員了')

    await sql.begin(async tx => {
      // 找來的人不見得已經在這個工作區裡。被請進專案就等於要進得了這個站的這一區，
      // 所以順手補一筆訪客身分 —— 沒有這一筆，他登入後根本看不到這個工作區，
      // 也就找不到剛剛被加進去的專案。訪客只是「被邀請進來的外部帳號」，
      // 不會因此看到任何他不是成員的專案。
      if (!target.ws) {
        await tx`
          INSERT INTO workspace_member (workspace_id, user_id, role)
          VALUES (${workspaceId}, ${body.userId}, 'GUEST')
          ON CONFLICT (workspace_id, user_id) DO NOTHING`
      }
      await tx`
        INSERT INTO project_member (project_id, user_id, role, added_by)
        VALUES (${req.params.id}, ${body.userId}, ${body.role}, ${user.id})`
      // 直接放進來的話，他自己送的申請就沒有意義了，一併結掉免得留在待審清單
      await tx`
        UPDATE project_join_request
        SET status = 'APPROVED', decided_by = ${user.id}, decided_at = now(),
            decided_note = '已由專案管理者直接加入'
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
      const { createdBy } = await requireProjectManager(user.id, req.params.id)
      const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body)

      // 建立者的角色誰都不能改（包含他自己）—— 他是專案最後一個一定管得動的人
      if (createdBy === req.params.userId) {
        throw badRequest('不能改專案建立者的角色')
      }
      // 自己把自己降級等於當場失去管理權，而且救不回來（只有管理者能改角色）
      if (user.id === req.params.userId) {
        throw badRequest('不能改自己的角色，請另一位管理者幫你改')
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
      const { createdBy } = await requireProjectManager(user.id, req.params.id)

      // 移掉建立者等於專案有機會沒人能管成員了，擋掉
      if (createdBy === req.params.userId) {
        throw badRequest('不能把專案的建立者移出專案')
      }
      // 自己把自己移出去也是一樣的死路：進不來就再也加不回來
      if (user.id === req.params.userId) {
        throw badRequest('不能把自己移出專案，請另一位管理者處理')
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

    const [p] = await sql<{ workspace_id: string; archived_at: string | null }[]>`
      SELECT workspace_id, archived_at FROM project WHERE id = ${req.params.id}`
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
    if (pending.length) throw conflict('你已經送出申請了，正在等專案的管理者處理')

    const [row] = await sql`
      INSERT INTO project_join_request (project_id, user_id, message)
      VALUES (${req.params.id}, ${user.id}, ${body.message ?? null})
      RETURNING id, status, created_at AS "createdAt"`

    // 管理者得知道有人在敲門。「成員」頁籤上的紅點只有進到那個專案才看得到，
    // 而會來申請的多半是他們近期沒在看的專案。
    // 每一位管理者都通知，因為每一位都處理得了 —— 只通知建立者的話，
    // 他放假時那筆申請就卡在沒有人被提醒的狀態。
    const managers = await sql<{ user_id: string }[]>`
      SELECT user_id FROM project_member
      WHERE project_id = ${req.params.id} AND role = 'MANAGER'`
    for (const m of managers) {
      await notify({
        db: sql, workspaceId: p.workspace_id, userId: m.user_id,
        kind: 'JOIN_REQUESTED', actorId: user.id, actorName: user.displayName,
        projectId: req.params.id, body: { message: body.message ?? null },
      })
    }
    return reply.code(201).send(row)
  })

  /** 待審清單。只有這個專案的管理者看得到誰想進來。 */
  app.get<{ Params: { id: string } }>('/projects/:id/join-requests', async req => {
    const user = await authenticate(req)
    await requireProjectManager(user.id, req.params.id)
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
      const { workspaceId } = await requireProjectManager(user.id, req.params.id)
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
      await requireProjectManager(user.id, req.params.id)
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
