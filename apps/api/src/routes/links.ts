import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { authenticate, requireTaskAccess } from '../lib/auth.js'
import { assertNoCycle, isScheduling, SYMMETRIC } from '../lib/graph.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'

const createBody = z.object({
  targetId: z.string().uuid(),
  linkType: z.enum(['FS', 'SS', 'FF', 'SF', 'RELATES', 'BLOCKS', 'DUPLICATES', 'REQUIRES']),
  lagDays: z.number().int().min(-365).max(365).optional(),
})

export default async function linkRoutes(app: FastifyInstance) {

  app.post<{ Params: { id: string } }>('/tasks/:id/links', async (req, reply) => {
    const user = await authenticate(req)
    const b = createBody.parse(req.body)

    // 兩端都要驗權限。只驗一端就是 Vikunja 2026 那個關聯 IDOR（GO-2026-4847）。
    const src = await requireTaskAccess(user.id, req.params.id, 'EDITOR')
    const tgt = await requireTaskAccess(user.id, b.targetId, 'EDITOR')

    if (src.workspaceId !== tgt.workspaceId) throw forbidden('不能跨工作區建立關聯')
    if (req.params.id === b.targetId) throw badRequest('任務不能關聯到自己')

    // 對稱型只存一列，用字典序決定方向，從資料層杜絕重複
    let sourceId = req.params.id
    let targetId = b.targetId
    if (SYMMETRIC.has(b.linkType) && sourceId > targetId) {
      [sourceId, targetId] = [targetId, sourceId]
    }

    const link = await sql.begin(async tx => {
      // 排程類才需要擋環；語意類（RELATES / BLOCKS…）不影響日期，成環無妨
      if (isScheduling(b.linkType)) {
        // 先驗祖先／後代關係。順序很重要：階層邊本身也算在環裡，
        // 若先跑 assertNoCycle，使用者只會看到「會造成循環依賴」這種
        // 不知所云的訊息，而不是真正的原因。具體的錯誤要先講。
        const [anc] = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM task_closure
          WHERE (ancestor_id = ${sourceId} AND descendant_id = ${targetId})
             OR (ancestor_id = ${targetId} AND descendant_id = ${sourceId})`
        if (anc) throw conflict('父子任務之間不能建立排程依賴', '父任務的日期已由子任務彙總')

        await assertNoCycle(tx, sourceId, targetId)
      }

      const [l] = await tx<{ id: string }[]>`
        INSERT INTO task_link (workspace_id, source_id, target_id, link_type, lag_days, created_by)
        VALUES (${src.workspaceId}, ${sourceId}, ${targetId}, ${b.linkType},
                ${b.lagDays ?? 0}, ${user.id})
        RETURNING id`

      await tx`INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body)
               VALUES (${src.workspaceId}, ${sourceId}, 'LINK_CHANGE', ${user.id},
                       ${user.displayName},
                       ${sql.json({ action: 'add', linkType: b.linkType, targetId })})`
      return l
    })

    const [row] = await sql`
      SELECT l.id, l.link_type AS "linkType", l.lag_days AS "lagDays",
             l.source_id AS "sourceId", l.target_id AS "targetId"
      FROM task_link l WHERE l.id = ${link.id}`
    return reply.code(201).send(row)
  })

  app.delete<{ Params: { id: string } }>('/links/:id', async (req, reply) => {
    const user = await authenticate(req)
    const [l] = await sql<{ source_id: string }[]>`
      SELECT source_id FROM task_link WHERE id = ${req.params.id}`
    if (!l) throw notFound('找不到這條關聯')
    await requireTaskAccess(user.id, l.source_id, 'EDITOR')
    await sql`DELETE FROM task_link WHERE id = ${req.params.id}`
    return reply.code(204).send()
  })

  /** 關聯網路圖用：一次拿整個專案的節點與邊 */
  app.get<{ Params: { id: string } }>('/projects/:id/graph', async req => {
    const user = await authenticate(req)
    const { requireProjectRole } = await import('../lib/auth.js')
    await requireProjectRole(user.id, req.params.id, 'VIEWER')

    const nodes = await sql`
      SELECT t.id, p.key || '-' || t.number AS ref, t.title, t.type,
             t.status_key AS "statusKey", t.progress, t.parent_id AS "parentId",
             t.inquiry_state AS "inquiryState"
      FROM task t JOIN project p ON p.id = t.project_id
      WHERE t.project_id = ${req.params.id} AND t.deleted_at IS NULL`

    const edges = await sql`
      SELECT l.id, l.source_id AS "sourceId", l.target_id AS "targetId",
             l.link_type AS "linkType", l.lag_days AS "lagDays"
      FROM task_link l
      JOIN task s ON s.id = l.source_id
      WHERE s.project_id = ${req.params.id}`

    return { nodes, edges }
  })
}
