import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { authenticate, requireProjectRole, requireTaskAccess } from '../lib/auth.js'
import { rankBetween } from '../lib/rank.js'
import { rebuildClosure, assertNotDescendant } from '../lib/graph.js'
import { schedule, type SchedTask, type SchedLink } from '../lib/schedule.js'
import { notify } from '../lib/notify.js'
import { badRequest, notFound } from '../lib/errors.js'

const TASK_COLUMNS = sql`
  t.id, t.project_id AS "projectId", t.workspace_id AS "workspaceId",
  p.key || '-' || t.number AS "ref", t.number, t.parent_id AS "parentId",
  t.title, t.description, t.type, t.status_key AS "statusKey", t.priority,
  t.assignee_id AS "assigneeId", u.display_name AS "assigneeName",
  (u.avatar_file IS NOT NULL) AS "assigneeHasAvatar",
  t.start_date AS "startDate", t.due_date AS "dueDate",
  t.estimate_hours AS "estimateHours", t.spent_hours AS "spentHours",
  t.progress, t.schedule_mode AS "scheduleMode", t.rank,
  t.inquiry_state AS "inquiryState", t.earliest_due_date AS "earliestDueDate",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`

const createBody = z.object({
  title: z.string().min(1, '請填寫任務標題').max(500),
  description: z.string().max(20000).optional(),
  type: z.enum(['TASK', 'MILESTONE', 'BUG', 'EPIC']).optional(),
  statusKey: z.string().max(40).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
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

    const created = await sql.begin(async tx => {
      const [{ next_number }] = await tx<{ next_number: number }[]>`
        UPDATE project SET next_number = next_number + 1
        WHERE id = ${req.params.id} RETURNING next_number - 1 AS next_number`

      if (body.parentId) {
        const [parent] = await tx<{ id: string }[]>`
          SELECT id FROM task WHERE id = ${body.parentId} AND deleted_at IS NULL`
        if (!parent) throw badRequest('指定的父任務不存在')
      }

      const [{ rank }] = await tx<{ rank: number }[]>`
        SELECT coalesce(max(rank), 0) + 1000 AS rank FROM task WHERE project_id = ${req.params.id}`

      const [t] = await tx<{ id: string }[]>`
        INSERT INTO task (workspace_id, project_id, number, parent_id, title, description,
                          type, status_key, priority, assignee_id, start_date, due_date,
                          estimate_hours, schedule_mode, rank, created_by)
        VALUES (${workspaceId}, ${req.params.id}, ${next_number}, ${body.parentId ?? null},
                ${body.title}, ${body.description ?? null}, ${body.type ?? 'TASK'},
                ${body.statusKey ?? 'todo'}, ${body.priority ?? 'NORMAL'},
                ${body.assigneeId ?? null}, ${body.startDate ?? null}, ${body.dueDate ?? null},
                ${body.estimateHours ?? null}, ${body.scheduleMode ?? 'AUTO'},
                ${rank}, ${user.id})
        RETURNING id`

      await rebuildClosure(tx, t.id)
      await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
               VALUES (${workspaceId}, ${t.id}, 'CREATED', ${user.id}, ${user.displayName},
                       ${sql.json({ title: body.title })})`

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
    const { workspaceId, projectId } = await requireTaskAccess(user.id, req.params.id, 'EDITOR')
    const b = patchBody.parse(req.body)

    await sql.begin(async tx => {
      if (b.parentId !== undefined) await assertNotDescendant(tx, req.params.id, b.parentId)

      // 舊的負責人要在 UPDATE 之前讀，不然就分不出「換人」和「本來就是他」——
      // 每次存檔都通知一次，通知很快就會被當成雜訊而沒人看
      const [before] = await tx<{ assignee_id: string | null }[]>`
        SELECT assignee_id FROM task WHERE id = ${req.params.id}`

      await tx`
        UPDATE task SET
          title          = coalesce(${b.title ?? null}, title),
          description    = ${b.description !== undefined ? b.description : sql`description`},
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

      await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
               VALUES (${workspaceId}, ${req.params.id}, 'FIELD_CHANGE',
                       ${user.id}, ${user.displayName}, ${sql.json(b as Record<string, never>)})`

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

  // ── 拖曳：改父層 / 排序 / 狀態欄 ───────────────────────
  app.post<{ Params: { id: string } }>('/tasks/:id/move', async req => {
    const user = await authenticate(req)
    await requireTaskAccess(user.id, req.params.id, 'EDITOR')
    const b = moveBody.parse(req.body)

    const neighbours = await sql<{ id: string; rank: string }[]>`
      SELECT id, rank::text FROM task
      WHERE id = ANY(${[b.beforeId, b.afterId].filter(Boolean) as string[]}::uuid[])`
    const rankOf = (id?: string | null) =>
      id ? Number(neighbours.find(n => n.id === id)?.rank ?? null) : null

    // beforeId = 要排在它前面 → 新 rank 落在「它的前一個」與「它」之間
    const { rank } = rankBetween(rankOf(b.afterId), rankOf(b.beforeId))

    await sql.begin(async tx => {
      if (b.parentId !== undefined) await assertNotDescendant(tx, req.params.id, b.parentId)
      await tx`
        UPDATE task SET
          rank       = ${rank},
          status_key = coalesce(${b.statusKey ?? null}, status_key),
          parent_id  = ${b.parentId !== undefined ? b.parentId : sql`parent_id`},
          updated_at = now()
        WHERE id = ${req.params.id}`
      if (b.parentId !== undefined) await rebuildClosure(tx, req.params.id)
    })

    return loadTask(req.params.id)
  })

  // ── 拖曳甘特長條：改日期，可連動下游 ───────────────────
  app.post<{ Params: { id: string } }>('/tasks/:id/reschedule', async req => {
    const user = await authenticate(req)
    const { projectId } = await requireTaskAccess(user.id, req.params.id, 'EDITOR')
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
    await requireTaskAccess(user.id, req.params.id, 'EDITOR')
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
