import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { authenticate } from '../lib/auth.js'
import { notFound } from '../lib/errors.js'

/**
 * 通知的讀取端。產生端在 lib/notify.ts。
 *
 * 權限很單純：一則通知只屬於一個人，所有查詢都以 user_id 為條件，
 * 不需要 requireProjectRole —— 通知是當初「有權限知道」的那一刻寫下來的。
 * 但也因為這樣，回傳的內容只有標題與代號，點進去看內容時前端會重新打
 * 任務的 API，那時候才是真的鑑權（人可能已經被移出專案了）。
 *
 * 沒有 WebSocket，前端每 30 秒輪詢一次。
 */

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export default async function notificationRoutes(app: FastifyInstance) {

  app.get<{ Querystring: Record<string, string> }>('/notifications', async req => {
    const user = await authenticate(req)
    const { limit } = listQuery.parse(req.query)

    const items = await sql`
      SELECT n.id, n.kind, n.body, n.actor_name AS "actorName",
             n.read_at AS "readAt", n.created_at AS "createdAt",
             n.project_id AS "projectId", p.key AS "projectKey", p.name AS "projectName",
             n.task_id AS "taskId",
             CASE WHEN t.id IS NULL THEN NULL ELSE p.key || '-' || t.number END AS "taskRef",
             t.title AS "taskTitle"
      FROM notification n
      LEFT JOIN project p ON p.id = n.project_id
      LEFT JOIN task t ON t.id = n.task_id AND t.deleted_at IS NULL
      WHERE n.user_id = ${user.id}
      ORDER BY n.created_at DESC
      LIMIT ${limit}`

    // 未讀數獨立算，不能用 items 數 —— 清單有 limit，未讀可能落在後面
    const [{ unread }] = await sql<{ unread: number }[]>`
      SELECT count(*)::int AS unread FROM notification
      WHERE user_id = ${user.id} AND read_at IS NULL`

    return { items, unread }
  })

  app.post<{ Params: { id: string } }>('/notifications/:id/read', async req => {
    const user = await authenticate(req)
    const rows = await sql`
      UPDATE notification SET read_at = coalesce(read_at, now())
      WHERE id = ${req.params.id} AND user_id = ${user.id}
      RETURNING id`
    if (!rows.length) throw notFound('找不到這則通知')
    return { unread: await unreadCount(user.id) }
  })

  app.post('/notifications/read-all', async req => {
    const user = await authenticate(req)
    await sql`
      UPDATE notification SET read_at = now()
      WHERE user_id = ${user.id} AND read_at IS NULL`
    return { unread: 0 }
  })
}

async function unreadCount(userId: string): Promise<number> {
  const [{ unread }] = await sql<{ unread: number }[]>`
    SELECT count(*)::int AS unread FROM notification
    WHERE user_id = ${userId} AND read_at IS NULL`
  return unread
}
