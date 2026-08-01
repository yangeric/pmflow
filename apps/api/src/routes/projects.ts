import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { authenticate, requireProjectRole } from '../lib/auth.js'
import { forbidden, notFound } from '../lib/errors.js'

const DEFAULT_STATUSES = [
  { key: 'todo',    name: '待辦',   category: 'TODO',   color: '#94a3b8', rank: 1000 },
  { key: 'doing',   name: '進行中', category: 'ACTIVE', color: '#3178c6', rank: 2000 },
  { key: 'review',  name: '待驗收', category: 'ACTIVE', color: '#e07b39', rank: 3000 },
  { key: 'done',    name: '已完成', category: 'DONE',   color: '#2e8b57', rank: 4000 },
]

const createBody = z.object({
  workspaceId: z.string().uuid(),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, '專案代碼要 2–10 碼大寫英數，開頭為英文'),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
})

export default async function projectRoutes(app: FastifyInstance) {

  app.get('/projects', async req => {
    const user = await authenticate(req)
    const rows = await sql`
      SELECT p.id, p.workspace_id AS "workspaceId", p.key, p.name, p.description,
             p.color, p.status, p.start_date AS "startDate", p.end_date AS "endDate",
             p.rank, pm.role,
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.deleted_at IS NULL)::int AS "taskCount",
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.deleted_at IS NULL
                 AND t.inquiry_state = 'OVERDUE')::int AS "overdueInquiryCount"
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
        INSERT INTO project (workspace_id, key, name, description, color, start_date, end_date, rank)
        VALUES (${body.workspaceId}, ${body.key}, ${body.name},
                ${body.description ?? null}, ${body.color ?? '#3178c6'},
                ${body.startDate ?? null}, ${body.endDate ?? null},
                (SELECT coalesce(max(rank), 0) + 1000 FROM project WHERE workspace_id = ${body.workspaceId}))
        RETURNING id`
      await tx`INSERT INTO project_member (project_id, user_id, role)
               VALUES (${p.id}, ${user.id}, 'MANAGER')`
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
             start_date AS "startDate", end_date AS "endDate"
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
        end_date    = coalesce(${body.endDate ?? null}, end_date)
      WHERE id = ${req.params.id}
      RETURNING id, key, name, description, color,
                start_date AS "startDate", end_date AS "endDate"`
    return row
  })
}
