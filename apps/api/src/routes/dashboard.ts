import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { authenticate, requireProjectRole } from '../lib/auth.js'
import {
  computeBurndown, currentDate, addDays, clampRange, countWorkdays,
  eachDay, isWeekend, round2, type DashboardMetric,
} from '../lib/burndown.js'

/**
 * 專案儀表板：燃盡圖與負載熱圖。
 *
 * 兩支都只要 VIEWER —— 這裡回的是專案內部的彙總，看得到專案就看得到它，
 * 而「誰忙不過來」正是專案裡的人都該知道的事，鎖在管理者手上沒有意義。
 *
 * 兩支都不存任何東西：燃盡是把活動紀錄重播出來的（見 lib/burndown.ts），
 * 負載是把任務的日期攤平算出來的。沒有快取、沒有排程、沒有新資料表 ——
 * 資料一改，下一次打開就是對的。
 */

const rangeQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  /** 用張數還是工時看。兩種問的是不同的問題，不是同一張圖的兩個單位 */
  metric: z.enum(['count', 'hours']).default('count'),
})

/**
 * 熱圖上「滿載」的那條線：工時一天 8 小時，張數一天 3 張。
 * 這是畫紅字的門檻，不是規定誰一天要做幾件事 —— 超過只代表那天值得看一眼。
 */
const CAPACITY: Record<DashboardMetric, number> = { hours: 8, count: 3 }

export default async function dashboardRoutes(app: FastifyInstance) {

  // ── 燃盡圖 ───────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/projects/:id/burndown', async req => {
      const user = await authenticate(req)
      await requireProjectRole(user.id, req.params.id, 'VIEWER')
      const q = rangeQuery.parse(req.query)
      const today = await currentDate()

      const { from, to } = clampRange(...await burndownRange(req.params.id, q, today))
      const result = await computeBurndown(req.params.id, { from, to, today, metric: q.metric })

      // 今天不在區間裡就沒有「今天剩多少」可講。硬拿最後一天充數的話，
      // 看歷史區間的人會以為那是現在的狀況
      const now = result.points.find(p => p.isToday) ?? null

      return {
        from, to, metric: q.metric,
        points: result.points,
        taskCount: result.taskCount,
        estimatedCount: result.estimatedCount,
        todayRemaining: now?.remaining ?? null,
        todayIdeal: now?.ideal ?? null,
      }
    })

  // ── 負載熱圖 ─────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/projects/:id/workload', async req => {
      const user = await authenticate(req)
      await requireProjectRole(user.id, req.params.id, 'VIEWER')
      const q = rangeQuery.parse(req.query)
      const today = await currentDate()

      // 預設是「往前一週、往後三週」。往前是為了看見剛剛才擠在一起的那幾天，
      // 往後是為了在來得及調整的時候看見它
      const { from, to } = clampRange(
        q.from ?? addDays(today, -7), q.to ?? addDays(today, 20))

      /*
       * 排除大項目與已完成的任務：
       *  - 大項目是容器，它的日期是子任務撐出來的，算進來等於每件事壓兩次。
       *  - 已經做完的事不該還壓在誰身上。熱圖要回答的是「接下來誰忙不過來」，
       *    做完的事留在圖上只會讓每個人看起來都超載。
       * 狀態的分類是 per project 的（task_status），所以要 join 回去問，
       * 不能比對 key。查不到對應狀態的（狀態欄被刪掉）當成還沒完成。
       */
      const tasks = await sql<{
        id: string; assigneeId: string | null
        startDate: string; dueDate: string; estimateHours: number | null
      }[]>`
        SELECT t.id, t.assignee_id AS "assigneeId",
               to_char(coalesce(t.start_date, t.due_date), 'YYYY-MM-DD') AS "startDate",
               to_char(coalesce(t.due_date, t.start_date), 'YYYY-MM-DD') AS "dueDate",
               t.estimate_hours::float8 AS "estimateHours"
        FROM task t
        LEFT JOIN task_status s ON s.project_id = t.project_id AND s.key = t.status_key
        WHERE t.project_id = ${req.params.id} AND t.deleted_at IS NULL
          AND t.type <> 'EPIC'
          AND coalesce(s.category, 'ACTIVE') <> 'DONE'
          -- 一邊都沒有的任務排不進任何一天。硬給它一個日期是替使用者
          -- 決定「這件事什麼時候做」，那不是熱圖該做的事
          AND coalesce(t.start_date, t.due_date) IS NOT NULL
          AND coalesce(t.start_date, t.due_date) <= ${to}::date
          AND coalesce(t.due_date, t.start_date) >= ${from}::date`

      const assigneeIds = [...new Set(tasks.map(t => t.assigneeId).filter(Boolean))] as string[]

      // 專案成員都要列（有人整段時間都沒事，那本身就是資訊），
      // 再加上有任務落在區間內、但已經被移出專案的人 —— 他們的事還在，
      // 不列出來的話那些工作就從圖上消失了
      const people = await sql<{ id: string; displayName: string; hasAvatar: boolean }[]>`
        SELECT u.id, u.display_name AS "displayName",
               (u.avatar_file IS NOT NULL) AS "hasAvatar"
        FROM app_user u
        WHERE u.id IN (SELECT user_id FROM project_member WHERE project_id = ${req.params.id})
           OR u.id = ANY(${assigneeIds}::uuid[])`

      // 請假是掛在工作區上的（見 0009_leave.sql），所以由專案反查工作區。
      // 區間比對用「有沒有重疊」，跨月的假期在後半段一樣要看得到
      const leaves = await sql<{ userId: string; startDate: string; endDate: string }[]>`
        SELECT l.user_id AS "userId",
               to_char(l.start_date, 'YYYY-MM-DD') AS "startDate",
               to_char(l.end_date, 'YYYY-MM-DD') AS "endDate"
        FROM leave_record l
        JOIN project p ON p.workspace_id = l.workspace_id
        WHERE p.id = ${req.params.id}
          AND l.end_date >= ${from}::date AND l.start_date <= ${to}::date`

      const days = eachDay(from, to)
      const index = new Map(days.map((d, i) => [d, i]))

      /** 一列 = 一個人（或「沒有指定負責人」）。userId 為 null 的那列固定只有一條 */
      const rows = new Map<string | null, { load: number[]; taskCount: number[] }>()
      const rowOf = (userId: string | null) => {
        let r = rows.get(userId)
        if (!r) {
          r = { load: days.map(() => 0), taskCount: days.map(() => 0) }
          rows.set(userId, r)
        }
        return r
      }
      for (const p of people) rowOf(p.id)

      for (const t of tasks) {
        const row = rowOf(t.assigneeId)

        /*
         * 攤法看指標：
         *  - 工時：預估工時平均攤在**整段的工作日**上。除數用整段而不是
         *    看得見的那幾天，否則跨出視窗的長任務會被攤成好幾倍。
         *    整段都落在週末時退回按日曆日攤 —— 不然那些工時會憑空消失。
         *  - 張數：區間內的每一天都算一張（含週末）。週末只是畫得淡一點，
         *    那是前端的事；一件事跨過週末，它在週末依然壓在那個人身上。
         */
        const workdays = countWorkdays(t.startDate, t.dueDate)
        const spanDays = workdays || eachDay(t.startDate, t.dueDate).length
        const perDay = q.metric === 'count'
          ? 1
          : (t.estimateHours ? t.estimateHours / spanDays : 0)

        const visibleFrom = t.startDate > from ? t.startDate : from
        const visibleTo = t.dueDate < to ? t.dueDate : to
        for (const date of eachDay(visibleFrom, visibleTo)) {
          const i = index.get(date)!
          // 「幾張任務」不分平日假日 —— 那格的工時是 0，不代表那天沒事，
          // 可能只是沒有人估過那件事要多久
          row.taskCount[i] += 1
          if (q.metric === 'hours' && workdays > 0 && isWeekend(date)) continue
          row.load[i] += perDay
        }
      }

      // 請假的起訖日都含當天（見 0009_leave.sql），所以是閉區間比對
      const onLeave = (userId: string | null, date: string) =>
        userId !== null && leaves.some(
          l => l.userId === userId && l.startDate <= date && l.endDate >= date)

      const nameOf = new Map(people.map(p => [p.id, p]))
      const out = [...rows.entries()]
        .map(([userId, r]) => {
          const person = userId ? nameOf.get(userId) : undefined
          return {
            userId,
            displayName: person?.displayName ?? '沒有指定負責人',
            hasAvatar: person?.hasAvatar ?? false,
            cells: days.map((date, i) => ({
              date,
              load: round2(r.load[i]),
              taskCount: r.taskCount[i],
              onLeave: onLeave(userId, date),
            })),
            total: round2(r.load.reduce((a, b) => a + b, 0)),
            peak: round2(Math.max(0, ...r.load)),
          }
        })
        // 整段時間什麼都沒有的人不列。工時模式要看「有沒有任務」而不是
        // 「工時是不是 0」—— 沒人估工時的專案會讓每一列都變成 0，
        // 那時候整張圖就空了
        .filter(r => r.total > 0 || r.cells.some(c => c.taskCount > 0))
        .sort((a, b) => {
          // 「沒有指定負責人」固定放最後：那是一疊還沒決定誰做的事，
          // 混在人名中間會被當成某個人
          if (a.userId === null) return 1
          if (b.userId === null) return -1
          return a.displayName.localeCompare(b.displayName)
        })

      return {
        from, to, metric: q.metric,
        days: days.map(date => ({
          date, isWeekend: isWeekend(date), isToday: date === today,
        })),
        rows: out,
        capacity: CAPACITY[q.metric],
        max: Math.max(0, ...out.flatMap(r => r.cells.map(c => c.load))),
      }
    })
}

/**
 * 燃盡圖沒指定區間時該畫哪一段。
 *
 * 順序是「專案自己填的期程 → 任務實際佔到的期間 → 今天往前 30 天」。
 * 專案的期程優先，因為那是人講出來的計畫，燃盡圖問的正是「照這個計畫走得完嗎」；
 * 沒填才退回去看任務實際落在哪裡。兩頭各自判斷 —— 只填了開始日的專案很常見。
 */
async function burndownRange(
  projectId: string, q: { from?: string; to?: string }, today: string
): Promise<[string, string]> {
  if (q.from && q.to) return [q.from, q.to]

  const [row] = await sql<{
    projectStart: string | null; projectEnd: string | null
    firstTask: string | null; lastTask: string | null
  }[]>`
    SELECT to_char(p.start_date, 'YYYY-MM-DD') AS "projectStart",
           to_char(p.end_date, 'YYYY-MM-DD') AS "projectEnd",
           -- least/greatest 會忽略 NULL，所以只填了一邊的任務也算得進來
           to_char(min(least(t.start_date, t.created_at::date)), 'YYYY-MM-DD') AS "firstTask",
           to_char(max(t.due_date), 'YYYY-MM-DD') AS "lastTask"
    FROM project p
    LEFT JOIN task t ON t.project_id = p.id AND t.deleted_at IS NULL AND t.type <> 'EPIC'
    WHERE p.id = ${projectId}
    GROUP BY p.start_date, p.end_date`

  return [
    q.from ?? row?.projectStart ?? row?.firstTask ?? addDays(today, -30),
    q.to ?? row?.projectEnd ?? row?.lastTask ?? today,
  ]
}
