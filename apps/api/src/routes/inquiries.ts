import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { env } from '../lib/env.js'
import { authenticate, requireTaskAccess } from '../lib/auth.js'
import { recalcInquiryState, addWorkingDays, toISODate } from '../lib/inquiry.js'
import { forbidden, notFound } from '../lib/errors.js'

const INQUIRY_COLUMNS = sql`
  id, task_id AS "taskId", seq,
  asked_to_unit AS "askedToUnit", asked_to_person AS "askedToPerson",
  asked_to_contact AS "askedToContact", asked_at AS "askedAt",
  due_date AS "dueDate", question,
  is_replied AS "isReplied", replied_by_unit AS "repliedByUnit",
  replied_by_person AS "repliedByPerson", replied_at AS "repliedAt",
  reply_note AS "replyNote",
  status, days_elapsed AS "daysElapsed",
  days_to_reply AS "daysToReply", days_overdue AS "daysOverdue"`

const createBody = z.object({
  askedToUnit: z.string().trim().min(1, '請填寫要提給哪個單位').max(120),
  askedToPerson: z.string().trim().max(80).optional(),
  askedToContact: z.string().trim().max(200).optional(),
  askedAt: z.string().date().optional(),
  dueDate: z.string().date().nullable().optional(),
  question: z.string().max(4000).optional(),
})

const patchBody = createBody.partial()

/**
 * 登錄回覆。三個 by* 欄位省略時，預設帶入提問側的值與今天 ——
 * 多數情況兩者相同，但兩個欄位都可以改：
 * 「發文給資訊部、實際是委外廠商回」在機關與大企業是常態。
 */
const markRepliedBody = z.object({
  repliedByUnit: z.string().trim().max(120).optional(),
  repliedByPerson: z.string().trim().max(80).optional(),
  repliedAt: z.string().date().optional(),
  replyNote: z.string().max(4000).optional(),
})

export default async function inquiryRoutes(app: FastifyInstance) {

  /**
   * 發文追蹤的站台設定。目前只有一個「預設幾個工作天回覆」。
   *
   * 前端要在畫面上先把期望回覆日算出來給人看，就必須知道這個數字；
   * 寫死在前端的話，站台把環境變數調成別的天數時兩邊就對不上了。
   */
  app.get('/inquiry-settings', async req => {
    await authenticate(req)
    return { defaultDueDays: env.inquiryDefaultDueDays }
  })

  app.get<{ Params: { id: string } }>('/tasks/:id/inquiries', async req => {
    const user = await authenticate(req)
    await requireTaskAccess(user.id, req.params.id, 'VIEWER')
    const rows = await sql`
      SELECT ${INQUIRY_COLUMNS} FROM v_inquiry
      WHERE task_id = ${req.params.id} ORDER BY seq, asked_at`
    return { inquiries: rows }
  })

  app.post<{ Params: { id: string } }>('/tasks/:id/inquiries', async (req, reply) => {
    const user = await authenticate(req)
    const { workspaceId } = await requireTaskAccess(user.id, req.params.id, 'EDITOR')
    const b = createBody.parse(req.body)

    const askedAt = b.askedAt ?? toISODate(new Date())
    // 沒填期望回覆日就自動帶「提問日 + N 個工作天」。
    // 有預設值，逾期統計才不會因為大家懶得填而失真。
    const dueDate = b.dueDate !== undefined
      ? b.dueDate
      : env.inquiryDefaultDueDays > 0
        ? toISODate(addWorkingDays(new Date(askedAt + 'T00:00:00Z'), env.inquiryDefaultDueDays))
        : null

    const created = await sql.begin(async tx => {
      const [{ seq }] = await tx<{ seq: number }[]>`
        SELECT coalesce(max(seq), 0) + 1 AS seq FROM task_inquiry WHERE task_id = ${req.params.id}`
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO task_inquiry
          (workspace_id, task_id, seq, asked_to_unit, asked_to_person, asked_to_contact,
           asked_at, due_date, question, asked_by)
        VALUES (${workspaceId}, ${req.params.id}, ${seq}, ${b.askedToUnit},
                ${b.askedToPerson ?? null}, ${b.askedToContact ?? null},
                ${askedAt}, ${dueDate}, ${b.question ?? null}, ${user.id})
        RETURNING id`
      await recalcInquiryState(tx, req.params.id)
      await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
               VALUES (${workspaceId}, ${req.params.id}, 'INQUIRY_CHANGE', ${user.id},
                       ${user.displayName},
                       ${sql.json({ action: 'ask', unit: b.askedToUnit, dueDate })})`
      return row
    })

    return reply.code(201).send(await loadInquiry(created.id))
  })

  app.patch<{ Params: { id: string } }>('/inquiries/:id', async req => {
    const user = await authenticate(req)
    const { taskId } = await accessInquiry(user.id, req.params.id, 'EDITOR')
    const b = patchBody.parse(req.body)

    await sql.begin(async tx => {
      await tx`
        UPDATE task_inquiry SET
          asked_to_unit    = coalesce(${b.askedToUnit ?? null}, asked_to_unit),
          asked_to_person  = ${b.askedToPerson !== undefined ? b.askedToPerson : sql`asked_to_person`},
          asked_to_contact = ${b.askedToContact !== undefined ? b.askedToContact : sql`asked_to_contact`},
          asked_at         = coalesce(${b.askedAt ?? null}, asked_at),
          due_date         = ${b.dueDate !== undefined ? b.dueDate : sql`due_date`},
          question         = ${b.question !== undefined ? b.question : sql`question`},
          updated_at       = now()
        WHERE id = ${req.params.id}`
      await recalcInquiryState(tx, taskId)
    })
    return loadInquiry(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/inquiries/:id/mark-replied', async req => {
    const user = await authenticate(req)
    // COMMENTER 就能登錄回覆 —— 實務上接到電話說「我們回了」的人，
    // 常常不是有編輯權的專案經理
    const { taskId, workspaceId } = await accessInquiry(user.id, req.params.id, 'COMMENTER')
    const b = markRepliedBody.parse(req.body)

    await sql.begin(async tx => {
      await tx`
        UPDATE task_inquiry SET
          is_replied        = true,
          replied_by_unit   = coalesce(${b.repliedByUnit ?? null}, replied_by_unit, asked_to_unit),
          replied_by_person = coalesce(${b.repliedByPerson ?? null}, replied_by_person, asked_to_person),
          replied_at        = coalesce(${b.repliedAt ?? null}, replied_at, CURRENT_DATE),
          reply_note        = ${b.replyNote !== undefined ? b.replyNote : sql`reply_note`},
          recorded_by       = ${user.id},
          updated_at        = now()
        WHERE id = ${req.params.id}`
      await recalcInquiryState(tx, taskId)
      await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
               VALUES (${workspaceId}, ${taskId}, 'INQUIRY_CHANGE', ${user.id}, ${user.displayName},
                       ${sql.json({ action: 'replied', ...b })})`
    })
    return loadInquiry(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/inquiries/:id/reopen', async req => {
    const user = await authenticate(req)
    const { taskId } = await accessInquiry(user.id, req.params.id, 'EDITOR')
    await sql.begin(async tx => {
      await tx`
        UPDATE task_inquiry SET is_replied = false, replied_at = NULL,
               replied_by_unit = NULL, replied_by_person = NULL, updated_at = now()
        WHERE id = ${req.params.id}`
      await recalcInquiryState(tx, taskId)
    })
    return loadInquiry(req.params.id)
  })

  app.delete<{ Params: { id: string } }>('/inquiries/:id', async (req, reply) => {
    const user = await authenticate(req)
    const { taskId } = await accessInquiry(user.id, req.params.id, 'EDITOR')
    await sql.begin(async tx => {
      await tx`DELETE FROM task_inquiry WHERE id = ${req.params.id}`
      await recalcInquiryState(tx, taskId)
    })
    return reply.code(204).send()
  })

  // ── 單位 typeahead：自由文字欄位，但把用過的值列出來當提示 ──
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/workspaces/:id/unit-suggestions', async req => {
      const user = await authenticate(req)
      await requireWorkspaceMember(user.id, req.params.id)
      const q = (req.query.q ?? '').trim()
      return {
        units: await sql`
          SELECT unit, usage_count AS "usageCount", last_used_on AS "lastUsedOn"
          FROM v_unit_suggestion
          WHERE workspace_id = ${req.params.id}
            ${q ? sql`AND unit ILIKE ${'%' + q + '%'}` : sql``}
          ORDER BY last_used_on DESC NULLS LAST, usage_count DESC
          LIMIT 20`,
      }
    })

  // ── 發文追蹤看板：跨專案 ──────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { state?: string; unit?: string } }>(
    '/workspaces/:id/inquiry-board', async req => {
      const user = await authenticate(req)
      await requireWorkspaceMember(user.id, req.params.id)
      const states = (req.query.state ?? 'AWAITING,OVERDUE,REPLIED').split(',')

      const rows = await sql`
        SELECT i.id, i.status, i.asked_to_unit AS "askedToUnit",
               i.asked_to_person AS "askedToPerson", i.asked_at AS "askedAt",
               i.due_date AS "dueDate", i.is_replied AS "isReplied",
               i.replied_by_unit AS "repliedByUnit", i.replied_at AS "repliedAt",
               i.days_elapsed AS "daysElapsed", i.days_overdue AS "daysOverdue",
               t.id AS "taskId", p.key || '-' || t.number AS "taskRef", t.title AS "taskTitle",
               p.id AS "projectId", p.name AS "projectName", p.color AS "projectColor"
        FROM v_inquiry i
        JOIN task t ON t.id = i.task_id AND t.deleted_at IS NULL
        JOIN project p ON p.id = t.project_id
        JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = ${user.id}
        WHERE i.workspace_id = ${req.params.id}
          AND i.status = ANY(${states})
          ${req.query.unit ? sql`AND (i.asked_to_unit = ${req.query.unit}
                                   OR i.replied_by_unit = ${req.query.unit})` : sql``}
        ORDER BY i.due_date NULLS LAST, i.asked_at`
      return { inquiries: rows }
    })

  // ── 單位回覆統計：哪個單位最常拖 ─────────────────────
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/workspaces/:id/inquiry-stats', async req => {
      const user = await authenticate(req)
      await requireWorkspaceMember(user.id, req.params.id)
      const from = req.query.from ?? '1970-01-01'
      const to = req.query.to ?? '2999-12-31'

      const byUnit = await sql`
        SELECT i.asked_to_unit AS unit,
               count(*)::int                                            AS "totalAsked",
               count(*) FILTER (WHERE i.is_replied)::int                AS "totalReplied",
               count(*) FILTER (WHERE i.status = 'OVERDUE')::int        AS "currentOverdue",
               round(avg(i.days_to_reply) FILTER (WHERE i.is_replied), 1) AS "avgDaysToReply",
               round(100.0 * count(*) FILTER (
                 WHERE i.is_replied AND i.due_date IS NOT NULL AND i.replied_at > i.due_date
               ) / nullif(count(*) FILTER (WHERE i.is_replied), 0), 1)  AS "lateReplyRate"
        FROM v_inquiry i
        JOIN task t ON t.id = i.task_id AND t.deleted_at IS NULL
        JOIN project_member pm ON pm.project_id = t.project_id AND pm.user_id = ${user.id}
        WHERE i.workspace_id = ${req.params.id} AND i.asked_at BETWEEN ${from} AND ${to}
        GROUP BY i.asked_to_unit
        ORDER BY count(*) DESC`

      // 提問單位 ≠ 回覆單位的案例，單獨列出來 —— 這是分開存兩組欄位才問得出來的問題
      const transferred = await sql`
        SELECT i.asked_to_unit AS "askedToUnit", i.replied_by_unit AS "repliedByUnit",
               count(*)::int AS count
        FROM task_inquiry i
        JOIN task t ON t.id = i.task_id AND t.deleted_at IS NULL
        JOIN project_member pm ON pm.project_id = t.project_id AND pm.user_id = ${user.id}
        WHERE i.workspace_id = ${req.params.id} AND i.is_replied
          AND i.replied_by_unit IS NOT NULL AND i.replied_by_unit <> i.asked_to_unit
        GROUP BY i.asked_to_unit, i.replied_by_unit
        ORDER BY count(*) DESC`

      return { byUnit, transferred }
    })
}

async function loadInquiry(id: string) {
  const [row] = await sql`SELECT ${INQUIRY_COLUMNS} FROM v_inquiry WHERE id = ${id}`
  return row ?? null
}

/** 子資源端點必須從 id 反查所屬任務再驗權限，不能因為拿得到 id 就放行 */
async function accessInquiry(
  userId: string, inquiryId: string, min: 'EDITOR' | 'COMMENTER' | 'VIEWER'
) {
  const [row] = await sql<{ task_id: string }[]>`
    SELECT task_id FROM task_inquiry WHERE id = ${inquiryId}`
  if (!row) throw notFound('找不到這筆詢問單')
  const r = await requireTaskAccess(userId, row.task_id, min)
  return { taskId: row.task_id, workspaceId: r.workspaceId }
}

async function requireWorkspaceMember(userId: string, workspaceId: string) {
  const rows = await sql`
    SELECT 1 FROM workspace_member WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`
  if (!rows.length) throw forbidden('你不是這個工作區的成員')
}
