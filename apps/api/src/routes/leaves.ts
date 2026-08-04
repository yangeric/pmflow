import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import {
  authenticate, requireWorkspaceAdmin, requireWorkspaceMember,
} from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'

/**
 * 請假。資料表見 migrations/0009_leave.sql。
 *
 * 權限的兩條規矩：
 *  1. **寫**：本人可以填自己的；工作區管理者可以幫任何人填、改、刪。
 *     「管理者」一律問 requireWorkspaceAdmin —— 那條規則剛改過（現在
 *     只有 ADMIN 算，OWNER 不算），這裡不要自己再查一次 role，
 *     不然哪天規則再變，這個檔會變成唯一沒跟上的地方。
 *  2. **讀**：同工作區的成員都看得到誰請假、哪幾天 —— 那是排工作的必要資訊，
 *     不是隱私。但**備註只有本人與管理者看得到**：請假的區間要公開，
 *     請假的理由不必。所以備註是在這一層濾掉的，不是靠前端不畫。
 *
 * 起日不能晚於迄日在三個地方各擋一次（前端、這裡、資料表 CHECK）：
 * 前端擋是為了當場給回饋，這裡擋是因為 API 不是只有前端會呼叫（有 API 權杖），
 * 資料表擋是因為反向區間會讓行事曆的長條算出負寬度，整列排版跟著爆。
 */

/** 假別的固定清單。畫面上的中文在 web/src/strings/calendar.ts，這裡只認 key */
const LEAVE_TYPES = [
  'PERSONAL', 'SICK', 'ANNUAL', 'OFFICIAL', 'MARRIAGE', 'BEREAVEMENT', 'OTHER',
] as const

const leaveType = z.enum(LEAVE_TYPES)

/** 空字串一律當成「沒填」—— 資料表的 CHECK 不收空白字串 */
const note = z.string().trim().max(500).nullish().transform(v => (v ? v : null))

const listQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
})

const createBody = z.object({
  /** 不給就是幫自己填。給了別人的 id 就要管理者權限 */
  userId: z.string().uuid().optional(),
  leaveType,
  startDate: z.string().date(),
  endDate: z.string().date(),
  note,
})

const patchBody = z.object({
  leaveType: leaveType.optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  note: note.optional(),
})

interface LeaveRow {
  id: string
  userId: string
  userName: string
  leaveType: (typeof LEAVE_TYPES)[number]
  startDate: string
  endDate: string
  days: number
  note: string | null
  createdById: string | null
  createdByName: string | null
  createdAt: string
}

/**
 * 是不是這個工作區的管理者。
 *
 * 借用 requireWorkspaceAdmin 而不是自己比對 role，理由見檔頭 ——
 * 這裡只是要一個布林值（清單上每一列都要標「你能不能改這筆」），
 * 所以把它的例外收掉。呼叫端一定已經先驗過「是不是這個工作區的成員」。
 */
async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  try {
    await requireWorkspaceAdmin(userId, workspaceId)
    return true
  } catch {
    return false
  }
}

/**
 * 起訖日一律用 to_char 轉成字串再回傳。
 *
 * date 欄位若讓驅動轉成 JS Date，序列化時會變成帶時區的 ISO 字串，
 * 在 UTC+8 就整批往前位移一天 —— 而那種錯誤在畫面上非常難察覺。
 */
const selectColumns = sql`
  l.id, l.user_id AS "userId", u.display_name AS "userName",
  l.leave_type AS "leaveType",
  to_char(l.start_date, 'YYYY-MM-DD') AS "startDate",
  to_char(l.end_date, 'YYYY-MM-DD') AS "endDate",
  (l.end_date - l.start_date + 1) AS days,
  l.note,
  l.created_by AS "createdById", c.display_name AS "createdByName",
  l.created_at AS "createdAt"`

/** 補上「這個人能不能改這筆」，並依權限決定備註給不給看 */
const forViewer = (row: LeaveRow, viewerId: string, canManage: boolean) => {
  const mine = row.userId === viewerId
  return {
    ...row,
    note: mine || canManage ? row.note : null,
    canEdit: mine || canManage,
  }
}

export default async function leaveRoutes(app: FastifyInstance) {

  // ── 這個工作區有誰請假 ────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/workspaces/:id/leaves', async req => {
      const user = await authenticate(req)
      const workspaceId = req.params.id
      await requireWorkspaceMember(user.id, workspaceId)
      const { from, to } = listQuery.parse(req.query)
      const canManage = await isWorkspaceAdmin(user.id, workspaceId)

      // 區間是「有沒有重疊」，不是「起日落在範圍內」——
      // 跨月的假期在後半個月一樣要看得到
      const rows = await sql<LeaveRow[]>`
        SELECT ${selectColumns}
        FROM leave_record l
        JOIN app_user u ON u.id = l.user_id
        LEFT JOIN app_user c ON c.id = l.created_by
        WHERE l.workspace_id = ${workspaceId}
          AND (${from ?? null}::date IS NULL OR l.end_date >= ${from ?? null}::date)
          AND (${to ?? null}::date IS NULL OR l.start_date <= ${to ?? null}::date)
        ORDER BY l.start_date, l.end_date, u.display_name`

      return {
        leaves: rows.map(r => forViewer(r, user.id, canManage)),
        canManage,
      }
    })

  // ── 登記請假 ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/workspaces/:id/leaves', async (req, reply) => {
    const user = await authenticate(req)
    const workspaceId = req.params.id
    await requireWorkspaceMember(user.id, workspaceId)
    const b = createBody.parse(req.body)

    const targetId = b.userId ?? user.id
    // 幫別人填是管理者的權力；填自己的不必是任何角色
    if (targetId !== user.id) await requireWorkspaceAdmin(user.id, workspaceId)
    if (b.startDate > b.endDate) throw badRequest('開始日不能晚於結束日')

    // 資料表的複合外鍵也擋得住，但那時只會回一句看不懂的違反外鍵
    const [member] = await sql`
      SELECT 1 FROM workspace_member
      WHERE workspace_id = ${workspaceId} AND user_id = ${targetId}`
    if (!member) throw badRequest('這個人不在這個工作區裡')

    const [row] = await sql<LeaveRow[]>`
      WITH ins AS (
        INSERT INTO leave_record
          (workspace_id, user_id, leave_type, start_date, end_date, note, created_by)
        VALUES (${workspaceId}, ${targetId}, ${b.leaveType},
                ${b.startDate}, ${b.endDate}, ${b.note}, ${user.id})
        RETURNING *
      )
      SELECT ${selectColumns}
      FROM ins l
      JOIN app_user u ON u.id = l.user_id
      LEFT JOIN app_user c ON c.id = l.created_by`

    reply.code(201)
    return forViewer(row, user.id, await isWorkspaceAdmin(user.id, workspaceId))
  })

  // ── 改一筆 ────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/leaves/:id', async req => {
    const user = await authenticate(req)
    const b = patchBody.parse(req.body)
    const { current, canManage } = await loadForWrite(user.id, req.params.id)

    // 只送了其中一個日期時，要拿另一個現值來比，不然改單邊就繞過檢查了
    const startDate = b.startDate ?? current.startDate
    const endDate = b.endDate ?? current.endDate
    if (startDate > endDate) throw badRequest('開始日不能晚於結束日')

    const [row] = await sql<LeaveRow[]>`
      WITH upd AS (
        UPDATE leave_record SET
          leave_type = ${b.leaveType ?? current.leaveType},
          start_date = ${startDate},
          end_date   = ${endDate},
          note       = ${b.note !== undefined ? b.note : current.note},
          updated_at = now()
        WHERE id = ${req.params.id}
        RETURNING *
      )
      SELECT ${selectColumns}
      FROM upd l
      JOIN app_user u ON u.id = l.user_id
      LEFT JOIN app_user c ON c.id = l.created_by`

    return forViewer(row, user.id, canManage)
  })

  // ── 刪一筆 ────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/leaves/:id', async (req, reply) => {
    const user = await authenticate(req)
    await loadForWrite(user.id, req.params.id)
    await sql`DELETE FROM leave_record WHERE id = ${req.params.id}`
    reply.code(204)
  })
}

/**
 * 改／刪之前的共同檢查：這筆存不存在、我是不是本人或管理者。
 *
 * 一定要由 id 反查 workspace_id 再驗權限，不能信任呼叫端說它屬於哪個工作區 ——
 * 這條規矩跟 requireTaskAccess 是同一個理由（IDOR）。
 */
async function loadForWrite(userId: string, leaveId: string) {
  const [row] = await sql<{
    workspaceId: string; userId: string
    leaveType: (typeof LEAVE_TYPES)[number]
    startDate: string; endDate: string; note: string | null
  }[]>`
    SELECT workspace_id AS "workspaceId", user_id AS "userId",
           leave_type AS "leaveType",
           to_char(start_date, 'YYYY-MM-DD') AS "startDate",
           to_char(end_date, 'YYYY-MM-DD') AS "endDate",
           note
    FROM leave_record WHERE id = ${leaveId}`
  if (!row) throw notFound('找不到這筆請假紀錄')

  await requireWorkspaceMember(userId, row.workspaceId)
  const canManage = await isWorkspaceAdmin(userId, row.workspaceId)
  // 不是本人也不是管理者：連「有沒有這筆」都不必回答
  if (row.userId !== userId && !canManage) throw notFound('找不到這筆請假紀錄')

  return { current: row, canManage }
}
