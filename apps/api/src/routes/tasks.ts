import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import {
  authenticate, currentDeputyPrincipals, requireProjectRole, requireTaskAccess,
} from '../lib/auth.js'
import { rankBetween } from '../lib/rank.js'
import { rebuildClosure, assertNotDescendant } from '../lib/graph.js'
import { assertTypeHierarchy } from '../lib/hierarchy.js'
import { schedule, type SchedTask, type SchedLink } from '../lib/schedule.js'
import { notify } from '../lib/notify.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { assertParamKey } from './parameters.js'
import { assertNoOpenInquiries } from '../lib/inquiry.js'

/**
 * 誰能改任務本身：**開這張任務的人、專案的建立者、專案管理者**，其他人不行。
 *
 * 為什麼要比「編輯者」更嚴：一張任務是誰開的，通常就是誰在追這件事。
 * 專案裡每個編輯者都能改別人的標題、日期、負責人的話，追蹤的人會發現
 * 自己開的任務莫名其妙變了樣，而活動紀錄要翻很久才知道是誰動的。
 *
 * **但「目前遇到的問題」與發文追蹤的回覆不受這條限制** —— 那兩件事本來就是
 * 「誰遇到誰寫、誰收到回覆誰登錄」，卡在權限上只會讓資訊留在別人的腦袋裡。
 * 那兩條路各自只要求專案成員身分，不走這個函式。
 *
 * **代理人也算**：請假的人指定的代理人，在代理期間（＝那筆請假的起訖日）
 * 就當成請假者本人（見 lib/auth.ts）。所以「開這張任務的人正在請假」時，
 * 他的代理人改得動這張任務 —— 不然人一請假，他開的那些任務就整批動不了。
 * 角色那一半已經在 requireProjectRole 裡取過聯集了，這裡只補「是不是關係人」。
 */
async function assertCanEditTask(
  taskId: string, userId: string, role: string
): Promise<void> {
  const [row] = await sql<{
    taskCreator: string | null; assigneeId: string | null; projectCreator: string | null; statusCategory: string | null
  }[]>`
    SELECT t.created_by AS "taskCreator", t.assignee_id AS "assigneeId", p.created_by AS "projectCreator", s.category AS "statusCategory"
    FROM task t
    JOIN project p ON p.id = t.project_id
    LEFT JOIN task_status s ON s.project_id = t.project_id AND s.key = t.status_key
    WHERE t.id = ${taskId}`
  if (!row) throw notFound('找不到任務')

  // 已完成的任務：鎖定，只有專案管理者 (MANAGER / 擁有者) 可以改
  if (row.statusCategory === 'DONE' && role !== 'MANAGER') {
    throw forbidden('已完成的任務已鎖定，只有專案管理者可以修改')
  }

  if (role === 'MANAGER') return
  if (row.taskCreator === userId || row.assigneeId === userId || row.projectCreator === userId) return

  const principals = await currentDeputyPrincipals(userId)
  if (principals.length && (
    (row.taskCreator && principals.includes(row.taskCreator)) ||
    (row.assigneeId && principals.includes(row.assigneeId)) ||
    (row.projectCreator && principals.includes(row.projectCreator))
  )) return

  throw forbidden('只有開這張任務的人、負責人、專案管理者及其代理人可以修改任務')
}

const TASK_COLUMNS = sql`
  t.id, t.project_id AS "projectId", t.workspace_id AS "workspaceId",
  p.key || '-' || t.number AS "ref", t.number, t.parent_id AS "parentId",
  t.title, t.description, t.problem, t.type, t.status_key AS "statusKey", t.priority,
  t.assignee_id AS "assigneeId", u.display_name AS "assigneeName",
  (u.avatar_file IS NOT NULL) AS "assigneeHasAvatar",
  t.start_date AS "startDate", t.due_date AS "dueDate",
  t.estimate_hours AS "estimateHours", t.spent_hours AS "spentHours",
  t.progress, t.schedule_mode AS "scheduleMode", t.rank,
  t.inquiry_state AS "inquiryState", t.earliest_due_date AS "earliestDueDate",
  -- 開這張任務的人。前端要靠它決定「這些控制項要不要畫出來」——
  -- 誰能改任務是看它加上專案角色（見上面的 assertCanEditTask），
  -- 不回傳的話前端只能把每個按鈕都畫出來，讓人按了才被拒絕。
  t.created_by AS "createdById",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`

/** 空白只有空白，就是「沒有問題」。資料庫也擋著空字串，兩種空值不要並存 */
const cleanProblem = (v: string | null | undefined) => (v?.trim() ? v.trim() : null)

const createBody = z.object({
  title: z.string().min(1, '請填寫任務標題').max(500),
  description: z.string().max(20000).optional(),
  /** 目前遇到的問題。解決了就送 null（或空字串）清掉 */
  problem: z.string().max(5000).nullable().optional(),
  /*
   * 類型與優先度**不再是固定清單** —— 每個專案自己定義（見
   * migrations/0011_project_parameters.sql）。所以這裡只收字串，
   * 「這個值在這個專案裡存不存在」由 assertParamKey 依 project_id 驗，
   * 跟 statusKey 從第一天起就是同一種做法。
   */
  type: z.string().max(40).optional(),
  statusKey: z.string().max(40).optional(),
  priority: z.string().max(40).optional(),
  parentId: z.string().uuid().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  startDate: z.string().date().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  estimateHours: z.number().min(0).max(99999).nullable().optional(),
  scheduleMode: z.enum(['AUTO', 'MANUAL']).optional(),
})

const patchBody = createBody.partial().extend({
  progress: z.number().int().min(0).max(100).optional(),
})

/**
 * 轉派：換負責人 ＋ 一句交接說明。
 *
 * 為什麼不併進 `PATCH /tasks/:id` 的 `assigneeId` —— 換成誰是欄位，
 * 「做到哪裡了、為什麼換」是話。兩者要落在同一筆活動紀錄上，接手的人才看得到
 * 來龍去脈；分兩支寫的話，時間軸上會變成「更新了欄位」加一則不知道在講哪次
 * 異動的留言，事後根本兜不回去。
 */
const reassignBody = z.object({
  /** null＝收回，不指派給任何人。這是合法的操作，不是漏填 */
  assigneeId: z.string().uuid().nullable(),
  note: z.string().max(2000).optional(),
})

/** 拖曳：改父層 / 改排序 / 改狀態欄，body 只帶「變更意圖」而非整個物件 */
const moveBody = z.object({
  parentId: z.string().uuid().nullable().optional(),
  statusKey: z.string().max(40).optional(),
  beforeId: z.string().uuid().nullable().optional(),  // 放在這張卡「之前」
  afterId: z.string().uuid().nullable().optional(),   // 放在這張卡「之後」
})

/** 拖曳甘特長條：改日期 */
const rescheduleBody = z.object({
  startDate: z.string().date().nullable(),
  dueDate: z.string().date().nullable(),
  cascade: z.boolean().optional(),
})

export default async function taskRoutes(app: FastifyInstance) {

  // ── 列出專案任務 ──────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/projects/:id/tasks', async req => {
      const user = await authenticate(req)
      await requireProjectRole(user.id, req.params.id, 'VIEWER')
      const q = req.query

      const rows = await sql`
        SELECT ${TASK_COLUMNS}
        FROM task t
        JOIN project p ON p.id = t.project_id
        LEFT JOIN app_user u ON u.id = t.assignee_id
        WHERE t.project_id = ${req.params.id} AND t.deleted_at IS NULL
          ${q.statusKey ? sql`AND t.status_key = ${q.statusKey}` : sql``}
          ${q.assigneeId ? sql`AND t.assignee_id = ${q.assigneeId}` : sql``}
          ${q.inquiryState ? sql`AND t.inquiry_state = ANY(${q.inquiryState.split(',')})` : sql``}
          ${q.search ? sql`AND t.title ILIKE ${'%' + q.search + '%'}` : sql``}
        ORDER BY t.rank, t.number`
      return { tasks: rows }
    })

  // ── 建立任務 ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/projects/:id/tasks', async (req, reply) => {
    const user = await authenticate(req)
    const { workspaceId } = await requireProjectRole(user.id, req.params.id, 'EDITOR')
    const body = createBody.parse(req.body)
    // 類型、優先度、狀態都是這個專案自己的清單，寫進去之前先確認值存在。
    // 資料表已經沒有 CHECK 擋了（見 0011_project_parameters.sql），這裡是唯一的關卡
    if (body.type) await assertParamKey(sql, req.params.id, 'type', body.type)
    if (body.priority) await assertParamKey(sql, req.params.id, 'priority', body.priority)
    if (body.statusKey) await assertParamKey(sql, req.params.id, 'status', body.statusKey)

    const created = await sql.begin(async tx => {
      const [{ next_number }] = await tx<{ next_number: number }[]>`
        UPDATE project SET next_number = next_number + 1
        WHERE id = ${req.params.id} RETURNING next_number - 1 AS next_number`

      if (body.parentId) {
        const [parent] = await tx<{ id: string }[]>`
          SELECT id FROM task WHERE id = ${body.parentId} AND deleted_at IS NULL`
        if (!parent) throw badRequest('指定的父任務不存在')
      }

      // 種類決定它能掛在誰底下（見 lib/hierarchy.ts）。建立時種類與上層都是
      // 這次決定的，所以一定要檢查 —— 沒填種類時寫進去的是 TASK，跟下面的 INSERT 一致
      await assertTypeHierarchy(tx, {
        nextType: body.type ?? 'TASK',
        nextParent: { id: body.parentId ?? null },
      })

      const [{ rank }] = await tx<{ rank: number }[]>`
        SELECT coalesce(max(rank), 0) + 1000 AS rank FROM task WHERE project_id = ${req.params.id}`

      const [t] = await tx<{ id: string }[]>`
        INSERT INTO task (workspace_id, project_id, number, parent_id, title, description,
                          problem, type, status_key, priority, assignee_id, start_date, due_date,
                          estimate_hours, schedule_mode, rank, created_by)
        VALUES (${workspaceId}, ${req.params.id}, ${next_number}, ${body.parentId ?? null},
                ${body.title}, ${body.description ?? null},
                ${cleanProblem(body.problem)}, ${body.type ?? 'TASK'},
                ${body.statusKey ?? 'todo'}, ${body.priority ?? 'NORMAL'},
                ${body.assigneeId ?? null}, ${body.startDate ?? null}, ${body.dueDate ?? null},
                ${body.estimateHours ?? null}, ${body.scheduleMode ?? 'AUTO'},
                ${rank}, ${user.id})
        RETURNING id`

      await rebuildClosure(tx, t.id)
      // 一起記下開出來時是什麼狀態。燃盡圖是把狀態變更重播回去畫的
      // （見 lib/burndown.ts），沒有這個起點就只能猜「它原本在第一欄」——
      // 而直接開在「進行中」甚至「已完成」的任務一點都不少見。
      // 值要跟真正寫進 status_key 的一樣，不能只寫 body.statusKey（可能沒填）
      await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
               VALUES (${workspaceId}, ${t.id}, 'CREATED', ${user.id}, ${user.displayName},
                       ${sql.json({ title: body.title, statusKey: body.statusKey ?? 'todo' })})`

      // 建立時就填了負責人，對那個人來說跟事後被指派是同一件事
      await notify({
        db: tx, workspaceId, userId: body.assigneeId,
        kind: 'TASK_ASSIGNED', actorId: user.id, actorName: user.displayName,
        projectId: req.params.id, taskId: t.id,
      })
      return t
    })

    return reply.code(201).send(await loadTask(created.id))
  })

  // ── 單張任務 ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/tasks/:id', async req => {
    const user = await authenticate(req)
    await requireTaskAccess(user.id, req.params.id, 'VIEWER')
    const task = await loadTask(req.params.id)
    if (!task) throw notFound('找不到任務')

    const links = await sql`
      SELECT l.id, l.link_type AS "linkType", l.lag_days AS "lagDays",
             'outgoing' AS direction, l.target_id AS "otherId",
             p.key || '-' || t.number AS "otherRef", t.title AS "otherTitle"
      FROM task_link l
      JOIN task t ON t.id = l.target_id JOIN project p ON p.id = t.project_id
      WHERE l.source_id = ${req.params.id}
      UNION ALL
      SELECT l.id, l.link_type, l.lag_days, 'incoming', l.source_id,
             p.key || '-' || t.number, t.title
      FROM task_link l
      JOIN task t ON t.id = l.source_id JOIN project p ON p.id = t.project_id
      WHERE l.target_id = ${req.params.id}`

    const children = await sql`
      SELECT t.id, p.key || '-' || t.number AS "ref", t.title, t.status_key AS "statusKey",
             t.progress, t.start_date AS "startDate", t.due_date AS "dueDate"
      FROM task t JOIN project p ON p.id = t.project_id
      WHERE t.parent_id = ${req.params.id} AND t.deleted_at IS NULL
      ORDER BY t.rank`

    const inquiries = await sql`
      SELECT id, seq, asked_to_unit AS "askedToUnit", asked_to_person AS "askedToPerson",
             asked_to_contact AS "askedToContact", asked_at AS "askedAt",
             due_date AS "dueDate", question, is_replied AS "isReplied",
             replied_by_unit AS "repliedByUnit", replied_by_person AS "repliedByPerson",
             replied_at AS "repliedAt", reply_note AS "replyNote",
             status, days_elapsed AS "daysElapsed",
             days_to_reply AS "daysToReply", days_overdue AS "daysOverdue"
      FROM v_inquiry WHERE task_id = ${req.params.id} ORDER BY seq, asked_at`

    const activities = await sql`
      SELECT id, kind, body, actor_name AS "actorName", created_at AS "createdAt"
      FROM activity WHERE task_id = ${req.params.id}
      ORDER BY created_at DESC LIMIT 100`

    return { ...task, links, children, inquiries, activities }
  })

  // ── 更新任務 ─────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/tasks/:id', async req => {
    const user = await authenticate(req)
    const b = patchBody.parse(req.body)
    // 只填「目前遇到的問題」的話，專案裡的任何人都可以 —— 那是「我卡在這裡」，
    // 不是在改別人的任務。其他欄位 (如標題、描述、狀態等) 一律要過 assertCanEditTask 權限檢查
    const onlyProblem = Object.keys(b).length > 0 && Object.keys(b).every(k => k === 'problem')
    const { workspaceId, projectId, role } = await requireTaskAccess(
      user.id, req.params.id, onlyProblem ? 'VIEWER' : 'EDITOR')
    if (!onlyProblem) await assertCanEditTask(req.params.id, user.id, role)

    if (b.type) await assertParamKey(sql, projectId, 'type', b.type)
    if (b.priority) await assertParamKey(sql, projectId, 'priority', b.priority)
    if (b.statusKey) await assertParamKey(sql, projectId, 'status', b.statusKey)
    if (b.statusKey) await assertNoOpenInquiries(sql, req.params.id, b.statusKey, projectId)

    await sql.begin(async tx => {
      if (b.parentId !== undefined) await assertNotDescendant(tx, req.params.id, b.parentId)

      await assertTypeHierarchy(tx, {
        taskId: req.params.id,
        nextType: b.type,
        nextParent: b.parentId !== undefined ? { id: b.parentId } : undefined,
      })

      const [before] = await tx<{
        title: string; description: string | null; problem: string | null; type: string; status_key: string; priority: string;
        assignee_id: string | null; parent_id: string | null; start_date: string | null; due_date: string | null;
        estimate_hours: number | null; schedule_mode: string; progress: number
      }[]>`
        SELECT title, description, problem, type, status_key, priority,
               assignee_id, parent_id, start_date::text, due_date::text,
               estimate_hours, schedule_mode, progress
        FROM task WHERE id = ${req.params.id}`

      const problem = cleanProblem(b.problem)

      await tx`
        UPDATE task SET
          title          = coalesce(${b.title ?? null}, title),
          description    = ${b.description !== undefined ? b.description : sql`description`},
          problem        = ${b.problem !== undefined ? problem : sql`problem`},
          type           = coalesce(${b.type ?? null}, type),
          status_key     = coalesce(${b.statusKey ?? null}, status_key),
          priority       = coalesce(${b.priority ?? null}, priority),
          assignee_id    = ${b.assigneeId !== undefined ? b.assigneeId : sql`assignee_id`},
          parent_id      = ${b.parentId !== undefined ? b.parentId : sql`parent_id`},
          start_date     = ${b.startDate !== undefined ? b.startDate : sql`start_date`},
          due_date       = ${b.dueDate !== undefined ? b.dueDate : sql`due_date`},
          estimate_hours = ${b.estimateHours !== undefined ? b.estimateHours : sql`estimate_hours`},
          schedule_mode  = coalesce(${b.scheduleMode ?? null}, schedule_mode),
          progress       = coalesce(${b.progress ?? null}, progress),
          updated_at     = now()
        WHERE id = ${req.params.id}`

      if (b.parentId !== undefined) await rebuildClosure(tx, req.params.id)

      const logged: Record<string, unknown> = {}
      if (b.title !== undefined && b.title !== before?.title) {
        logged.title = b.title
        logged.titleBefore = before?.title ?? null
      }
      if (b.description !== undefined && b.description !== before?.description) {
        logged.description = b.description
        logged.descriptionBefore = before?.description ?? null
      }
      if (b.statusKey !== undefined && b.statusKey !== before?.status_key) {
        logged.statusKey = b.statusKey
        logged.statusKeyBefore = before?.status_key ?? null
      }
      if (b.problem !== undefined && problem !== (before?.problem ?? null)) {
        logged.problem = problem
        logged.problemBefore = before?.problem ?? null
      }
      if (b.type !== undefined && b.type !== before?.type) {
        logged.type = b.type
        logged.typeBefore = before?.type ?? null
      }
      if (b.priority !== undefined && b.priority !== before?.priority) {
        logged.priority = b.priority
        logged.priorityBefore = before?.priority ?? null
      }
      if (b.assigneeId !== undefined && b.assigneeId !== before?.assignee_id) {
        logged.assigneeId = b.assigneeId
        logged.assigneeIdBefore = before?.assignee_id ?? null
      }
      if (b.parentId !== undefined && b.parentId !== before?.parent_id) {
        logged.parentId = b.parentId
        logged.parentIdBefore = before?.parent_id ?? null
      }
      if (b.startDate !== undefined && b.startDate !== before?.start_date) {
        logged.startDate = b.startDate
        logged.startDateBefore = before?.start_date ?? null
      }
      if (b.dueDate !== undefined && b.dueDate !== before?.due_date) {
        logged.dueDate = b.dueDate
        logged.dueDateBefore = before?.due_date ?? null
      }
      if (b.estimateHours !== undefined && b.estimateHours !== before?.estimate_hours) {
        logged.estimateHours = b.estimateHours
        logged.estimateHoursBefore = before?.estimate_hours ?? null
      }
      if (b.progress !== undefined && b.progress !== before?.progress) {
        logged.progress = b.progress
        logged.progressBefore = before?.progress ?? null
      }

      if (Object.keys(logged).length > 0) {
        await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
                 VALUES (${workspaceId}, ${req.params.id}, 'FIELD_CHANGE',
                         ${user.id}, ${user.displayName}, ${sql.json(logged as Record<string, never>)})`
      }

      if (b.assigneeId !== undefined && b.assigneeId !== before?.assignee_id) {
        await notify({
          db: tx, workspaceId, userId: b.assigneeId,
          kind: 'TASK_ASSIGNED', actorId: user.id, actorName: user.displayName,
          projectId, taskId: req.params.id,
        })
      }
    })

    return loadTask(req.params.id)
  })

  // ── 轉派：換負責人，可附一句交接說明 ────────────────────
  app.post<{ Params: { id: string } }>('/tasks/:id/reassign', async req => {
    const user = await authenticate(req)
    // 權限跟改任務一模一樣：換人就是改任務的一個欄位，不該比改標題寬鬆
    const { workspaceId, projectId, role } = await requireTaskAccess(
      user.id, req.params.id, 'EDITOR')
    await assertCanEditTask(req.params.id, user.id, role)
    const b = reassignBody.parse(req.body)
    const note = b.note?.trim() ? b.note.trim() : null

    /*
     * 指派的對象一定要是這個專案的成員。不是成員的人連專案都看不到，
     * 任務掛在他名下等於丟進黑洞 —— 他收不到、也查不到，
     * 而原本在追這件事的人還以為有人接手了。
     */
    let toName: string | null = null
    if (b.assigneeId) {
      const [m] = await sql<{ displayName: string }[]>`
        SELECT u.display_name AS "displayName"
        FROM project_member pm
        JOIN app_user u ON u.id = pm.user_id
        WHERE pm.project_id = ${projectId} AND pm.user_id = ${b.assigneeId}`
      if (!m) throw badRequest('只能指派給這個專案的成員，請先把他加入專案再指派任務。')
      toName = m.displayName
    }

    await sql.begin(async tx => {
      // 換人之前先讀原負責人：UPDATE 之後就查不回「本來是誰」了，
      // 而活動紀錄要寫的正是「從誰換成誰」
      const [before] = await tx<{ assigneeId: string | null; assigneeName: string | null }[]>`
        SELECT t.assignee_id AS "assigneeId", u.display_name AS "assigneeName"
        FROM task t LEFT JOIN app_user u ON u.id = t.assignee_id
        WHERE t.id = ${req.params.id}`
      const changed = (before?.assigneeId ?? null) !== b.assigneeId

      await tx`
        UPDATE task SET assignee_id = ${b.assigneeId}, updated_at = now()
        WHERE id = ${req.params.id}`

      /*
       * 沿用 FIELD_CHANGE，不新增一種 kind —— 負責人本來就是任務的欄位，
       * 時間軸也只有一條；而且 activity.kind 帶 CHECK 約束，多一種就得動
       * migration，不值得為了一句話改資料表。
       *
       * body 裡的 reassign 是給前端認的旗標（一般的欄位更新不會有它），
       * 換人前後的名字與那句話都收在同一筆，前端才組得出一句完整的中文。
       * 名字另外存一份是刻意的：帳號日後改名或被刪掉，這句話還是要讀得懂。
       *
       * 人沒換、又沒寫交接說明就不寫紀錄 —— 每按一次都留一筆的話，
       * 真正換過手的那幾筆會被淹掉。
       */
      if (changed || note) {
        await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
                 VALUES (${workspaceId}, ${req.params.id}, 'FIELD_CHANGE',
                         ${user.id}, ${user.displayName},
                         ${sql.json({
                           reassign: true,
                           assigneeId: b.assigneeId,
                           assigneeName: toName,
                           previousAssigneeId: before?.assigneeId ?? null,
                           previousAssigneeName: before?.assigneeName ?? null,
                           note,
                         } as unknown as Record<string, never>)})`
      }

      // 真的換了人才通知（自己指派給自己由 notify 自己擋掉）
      if (changed) {
        await notify({
          db: tx, workspaceId, userId: b.assigneeId,
          kind: 'TASK_ASSIGNED', actorId: user.id, actorName: user.displayName,
          projectId, taskId: req.params.id,
          body: note ? { note } : undefined,
        })
      }
    })

    return loadTask(req.params.id)
  })

  // ── 拖曳：改父層 / 排序 / 狀態欄 ───────────────────────
  app.post<{ Params: { id: string } }>('/tasks/:id/move', async req => {
    const user = await authenticate(req)
    const { workspaceId, projectId, role } = await requireTaskAccess(
      user.id, req.params.id, 'EDITOR')
    await assertCanEditTask(req.params.id, user.id, role)
    const b = moveBody.parse(req.body)
    // 拖到別的欄也是在改狀態，一樣要確認那個狀態存在、一樣不能帶著沒回的詢問結案
    if (b.statusKey) await assertParamKey(sql, projectId, 'status', b.statusKey)
    if (b.statusKey) await assertNoOpenInquiries(sql, req.params.id, b.statusKey, projectId)

    const neighbours = await sql<{ id: string; rank: string }[]>`
      SELECT id, rank::text FROM task
      WHERE id = ANY(${[b.beforeId, b.afterId].filter(Boolean) as string[]}::uuid[])`
    const rankOf = (id?: string | null) =>
      id ? Number(neighbours.find(n => n.id === id)?.rank ?? null) : null

    // beforeId = 要排在它前面 → 新 rank 落在「它的前一個」與「它」之間
    const { rank } = rankBetween(rankOf(b.afterId), rankOf(b.beforeId))

    await sql.begin(async tx => {
      if (b.parentId !== undefined) await assertNotDescendant(tx, req.params.id, b.parentId)

      // 拖曳只換上層，種類不動，但一樣要過同一關（見 lib/hierarchy.ts）——
      // 用拖的把問題拉到大項目底下，跟在詳情頁改上層是同一件事
      await assertTypeHierarchy(tx, {
        taskId: req.params.id,
        nextParent: b.parentId !== undefined ? { id: b.parentId } : undefined,
      })

      // UPDATE 之前先讀，理由跟 PATCH 那邊一樣：改完就查不回「本來在哪一欄」
      const [before] = await tx<{ status_key: string }[]>`
        SELECT status_key FROM task WHERE id = ${req.params.id}`

      await tx`
        UPDATE task SET
          rank       = ${rank},
          status_key = coalesce(${b.statusKey ?? null}, status_key),
          parent_id  = ${b.parentId !== undefined ? b.parentId : sql`parent_id`},
          updated_at = now()
        WHERE id = ${req.params.id}`
      if (b.parentId !== undefined) await rebuildClosure(tx, req.params.id)

      /*
       * 拖曳看板換欄也要留一筆狀態變更 —— 這條路以前完全不寫紀錄，
       * 於是「大家其實都是用拖的」的專案，燃盡圖回推出來會是一條平線
       * （見 lib/burndown.ts）。沿用 FIELD_CHANGE，跟在詳情頁改狀態同一種紀錄，
       * 時間軸上不該因為「用哪個畫面改的」而長得不一樣。
       *
       * 只改排序、只換父層不寫：那兩件事每拖一次就留一筆，
       * 真正換過欄的那幾筆會被淹掉，而它們才是燃盡圖要的。
       */
      if (b.statusKey && b.statusKey !== before?.status_key) {
        await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
                 VALUES (${workspaceId}, ${req.params.id}, 'FIELD_CHANGE',
                         ${user.id}, ${user.displayName},
                         ${sql.json({
                           statusKey: b.statusKey,
                           statusKeyBefore: before?.status_key ?? null,
                         })})`
      }
    })

    return loadTask(req.params.id)
  })

  // ── 拖曳甘特長條：改日期，可連動下游 ───────────────────
  app.post<{ Params: { id: string } }>('/tasks/:id/reschedule', async req => {
    const user = await authenticate(req)
    const { projectId, role } = await requireTaskAccess(user.id, req.params.id, 'EDITOR')
    await assertCanEditTask(req.params.id, user.id, role)
    const b = rescheduleBody.parse(req.body)

    await sql`
      UPDATE task SET start_date = ${b.startDate}, due_date = ${b.dueDate}, updated_at = now()
      WHERE id = ${req.params.id}`

    const result = await computeSchedule(projectId)

    // cascade：把推算結果寫回 AUTO 任務。MANUAL 的不動，只回報衝突。
    if (b.cascade !== false) {
      const updates = Object.entries(result.tasks)
        .filter(([id]) => id !== req.params.id)
      for (const [id, v] of updates) {
        await sql`
          UPDATE task SET start_date = ${v.start}, due_date = ${v.finish}, updated_at = now()
          WHERE id = ${id} AND schedule_mode = 'AUTO'
            AND (start_date IS DISTINCT FROM ${v.start}::date
              OR due_date  IS DISTINCT FROM ${v.finish}::date)`
      }
    }

    return { task: await loadTask(req.params.id), schedule: result }
  })

  // ── 排程結果：甘特圖用（含關鍵路徑與衝突清單）───────────
  app.get<{ Params: { id: string } }>('/projects/:id/schedule', async req => {
    const user = await authenticate(req)
    await requireProjectRole(user.id, req.params.id, 'VIEWER')
    return computeSchedule(req.params.id)
  })

  // ── 刪除（軟刪除）────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const user = await authenticate(req)
    const { role } = await requireTaskAccess(user.id, req.params.id, 'EDITOR')
    await assertCanEditTask(req.params.id, user.id, role)
    await sql`UPDATE task SET deleted_at = now() WHERE id = ${req.params.id}`
    return reply.code(204).send()
  })

  // ── 留言 ────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/tasks/:id/comments', async (req, reply) => {
    const user = await authenticate(req)
    const { workspaceId } = await requireTaskAccess(user.id, req.params.id, 'COMMENTER')
    const { text } = z.object({ text: z.string().min(1).max(20000) }).parse(req.body)
    const [row] = await sql`
      INSERT INTO activity (workspace_id, task_id, kind, body, actor_id, actor_name)
      VALUES (${workspaceId}, ${req.params.id}, 'COMMENT', ${sql.json({ text })},
              ${user.id}, ${user.displayName})
      RETURNING id, kind, body, actor_name AS "actorName", created_at AS "createdAt"`
    return reply.code(201).send(row)
  })
}

async function loadTask(id: string) {
  const [row] = await sql`
    SELECT ${TASK_COLUMNS}
    FROM task t
    JOIN project p ON p.id = t.project_id
    LEFT JOIN app_user u ON u.id = t.assignee_id
    WHERE t.id = ${id}`
  return row ?? null
}

export async function computeSchedule(projectId: string) {
  const tasks = await sql<{
    id: string; label: string; start_date: string | null;
    due_date: string | null; schedule_mode: 'AUTO' | 'MANUAL'
  }[]>`
    SELECT t.id, p.key || '-' || t.number AS label,
           to_char(t.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(t.due_date,   'YYYY-MM-DD') AS due_date,
           t.schedule_mode
    FROM task t JOIN project p ON p.id = t.project_id
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL`

  const links = await sql<{
    source_id: string; target_id: string; link_type: string; lag_days: number
  }[]>`
    SELECT l.source_id, l.target_id, l.link_type, l.lag_days
    FROM task_link l
    JOIN task s ON s.id = l.source_id
    WHERE s.project_id = ${projectId} AND l.link_type IN ('FS','SS','FF','SF')`

  const st: SchedTask[] = tasks.map(t => ({
    id: t.id, label: t.label,
    startDate: t.start_date, dueDate: t.due_date, scheduleMode: t.schedule_mode,
  }))
  const sl: SchedLink[] = links.map(l => ({
    sourceId: l.source_id, targetId: l.target_id,
    linkType: l.link_type as SchedLink['linkType'], lagDays: l.lag_days,
  }))
  return schedule(st, sl)
}
