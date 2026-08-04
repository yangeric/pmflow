import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { authenticate, requireProjectRole } from '../lib/auth.js'
import { forbidden, notFound } from '../lib/errors.js'

/**
 * 新專案開出來就有的狀態欄。
 *
 * 「待驗收 → 驗證中 → 驗證完成」是三件不同的事：東西交出去等人來驗（沒人在動）、
 * 有人正在驗、驗過了等收尾。全部擠在「待驗收」的話，看板上分不出
 * 「還沒人動」跟「正在驗」，而那正是每天要追的差別。
 *
 * 驗證完成算 DONE —— 驗過了就不該再被算進「還沒做完」的數字裡。
 */
const DEFAULT_STATUSES = [
  { key: 'todo',      name: '待辦',     category: 'TODO',   color: '#94a3b8', rank: 1000 },
  { key: 'doing',     name: '進行中',   category: 'ACTIVE', color: '#3178c6', rank: 2000 },
  { key: 'review',    name: '待驗收',   category: 'ACTIVE', color: '#e07b39', rank: 3000 },
  { key: 'verifying', name: '驗證中',   category: 'ACTIVE', color: '#8b5cf6', rank: 3200 },
  { key: 'verified',  name: '驗證完成', category: 'DONE',   color: '#0d9488', rank: 3500 },
  { key: 'done',      name: '已完成',   category: 'DONE',   color: '#2e8b57', rank: 4000 },
]

const createBody = z.object({
  workspaceId: z.string().uuid(),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, '專案代碼要 2–10 碼大寫英數，開頭為英文'),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  /**
   * 公開＝不用搜尋就出現在「加入其他專案」的清單裡。
   * 只影響找不找得到，不影響進不進得去 —— 一樣要建立者核准才會變成成員。
   */
  isPublic: z.boolean().optional(),
})

export default async function projectRoutes(app: FastifyInstance) {

  app.get('/projects', async req => {
    const user = await authenticate(req)
    const rows = await sql`
      SELECT p.id, p.workspace_id AS "workspaceId", p.key, p.name, p.description,
             p.color, p.status, p.start_date AS "startDate", p.end_date AS "endDate",
             p.rank, pm.role,
             (p.created_by = ${user.id}) AS "isCreator",
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.deleted_at IS NULL)::int AS "taskCount",
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.deleted_at IS NULL
                 AND t.inquiry_state = 'OVERDUE')::int AS "overdueInquiryCount",
             -- 待審的加入申請。不是建立者就一律 0，免得別人也看到有人在敲門
             (SELECT count(*) FROM project_join_request r
               WHERE r.project_id = p.id AND r.status = 'PENDING'
                 AND p.created_by = ${user.id})::int AS "pendingJoinRequestCount"
      FROM project p
      JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = ${user.id}
      WHERE p.archived_at IS NULL
      ORDER BY p.rank, p.created_at`
    return { projects: rows }
  })

  app.post('/projects', async (req, reply) => {
    const user = await authenticate(req)
    const body = createBody.parse(req.body)

    const member = await sql<{ role: string }[]>`
      SELECT role FROM workspace_member
      WHERE workspace_id = ${body.workspaceId} AND user_id = ${user.id}`
    if (!member.length) throw forbidden('你不是這個工作區的成員')
    if (!['OWNER', 'ADMIN', 'MEMBER'].includes(member[0].role)) {
      throw forbidden('訪客不能建立專案')
    }

    const project = await sql.begin(async tx => {
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO project (workspace_id, key, name, description, color, start_date, end_date,
                             rank, created_by)
        VALUES (${body.workspaceId}, ${body.key}, ${body.name},
                ${body.description ?? null}, ${body.color ?? '#3178c6'},
                ${body.startDate ?? null}, ${body.endDate ?? null},
                (SELECT coalesce(max(rank), 0) + 1000 FROM project WHERE workspace_id = ${body.workspaceId}),
                ${user.id})
        RETURNING id`
      await tx`INSERT INTO project_member (project_id, user_id, role, added_by)
               VALUES (${p.id}, ${user.id}, 'MANAGER', ${user.id})`
      for (const s of DEFAULT_STATUSES) {
        await tx`INSERT INTO task_status (project_id, key, name, category, color, rank)
                 VALUES (${p.id}, ${s.key}, ${s.name}, ${s.category}, ${s.color}, ${s.rank})`
      }
      return p
    })

    const [row] = await sql`
      SELECT id, workspace_id AS "workspaceId", key, name, description, color, status,
             start_date AS "startDate", end_date AS "endDate", rank
      FROM project WHERE id = ${project.id}`
    return reply.code(201).send(row)
  })

  app.get<{ Params: { id: string } }>('/projects/:id', async req => {
    const user = await authenticate(req)
    await requireProjectRole(user.id, req.params.id, 'VIEWER')
    const [p] = await sql`
      SELECT id, workspace_id AS "workspaceId", key, name, description, color, status,
             start_date AS "startDate", end_date AS "endDate",
             created_by AS "createdBy", (created_by = ${user.id}) AS "isCreator",
             is_public AS "isPublic"
      FROM project WHERE id = ${req.params.id}`
    if (!p) throw notFound('找不到專案')
    const statuses = await sql`
      SELECT id, key, name, category, color, rank, wip_limit AS "wipLimit"
      FROM task_status WHERE project_id = ${req.params.id} ORDER BY rank`
    const members = await sql`
      SELECT u.id, u.display_name AS "displayName", u.email, pm.role
      FROM project_member pm JOIN app_user u ON u.id = pm.user_id
      WHERE pm.project_id = ${req.params.id} ORDER BY u.display_name`
    return { ...p, statuses, members }
  })

  app.patch<{ Params: { id: string } }>('/projects/:id', async req => {
    const user = await authenticate(req)
    await requireProjectRole(user.id, req.params.id, 'MANAGER')
    const body = createBody.partial().omit({ workspaceId: true }).parse(req.body)
    const [row] = await sql`
      UPDATE project SET
        name        = coalesce(${body.name ?? null}, name),
        description = coalesce(${body.description ?? null}, description),
        color       = coalesce(${body.color ?? null}, color),
        start_date  = coalesce(${body.startDate ?? null}, start_date),
        end_date    = coalesce(${body.endDate ?? null}, end_date),
        is_public   = coalesce(${body.isPublic ?? null}, is_public)
      WHERE id = ${req.params.id}
      RETURNING id, key, name, description, color,
                start_date AS "startDate", end_date AS "endDate",
                is_public AS "isPublic"`
    return row
  })
}
