import type { Db } from './db.js'
import { badRequest } from './errors.js'

/**
 * 重算某張任務的對外詢問彙總欄位。
 * 詢問單每次新增／修改／刪除，都要在**同一個交易**內呼叫，
 * 否則看板篩選會拿到過期的狀態。
 *
 * NONE     沒有任何詢問單
 * AWAITING 全部未回覆，且沒有任何一張逾期
 * OVERDUE  至少一張未回覆且已過期望回覆日
 * PARTIAL  有些回了、有些還沒（且沒有逾期的）
 * REPLIED  全部都已回覆
 */
export async function recalcInquiryState(tx: Db, taskId: string): Promise<void> {
  await tx`
    WITH agg AS (
      SELECT
        count(*)                                              AS total,
        count(*) FILTER (WHERE is_replied)                    AS replied,
        count(*) FILTER (WHERE NOT is_replied
                           AND due_date IS NOT NULL
                           AND due_date < CURRENT_DATE)       AS overdue,
        min(due_date) FILTER (WHERE NOT is_replied)           AS earliest_due
      FROM task_inquiry WHERE task_id = ${taskId}
    )
    UPDATE task t SET
      inquiry_state = CASE
        WHEN agg.total   = 0          THEN 'NONE'
        WHEN agg.overdue > 0          THEN 'OVERDUE'
        WHEN agg.replied = agg.total  THEN 'REPLIED'
        WHEN agg.replied > 0          THEN 'PARTIAL'
        ELSE 'AWAITING' END,
      earliest_due_date = agg.earliest_due,
      updated_at = now()
    FROM agg
    WHERE t.id = ${taskId}`
}

/**
 * 每日逾期掃描：把跨過午夜才變成逾期的任務改成 OVERDUE。
 * 回傳受影響的任務數，方便排程工作寫 log。
 */
export async function sweepOverdue(tx: Db): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    WITH stale AS (
      SELECT DISTINCT t.id
      FROM task t
      JOIN task_inquiry i ON i.task_id = t.id
      WHERE NOT i.is_replied
        AND i.due_date IS NOT NULL
        AND i.due_date < CURRENT_DATE
        AND t.inquiry_state <> 'OVERDUE'
        AND t.deleted_at IS NULL
    )
    UPDATE task t
    SET inquiry_state = 'OVERDUE', updated_at = now()
    FROM stale WHERE t.id = stale.id
    RETURNING t.id`
  return rows.length
}

/** 期望回覆日預設值：提問日 + N 個工作天（跳過六日）。 */
export function addWorkingDays(from: Date, days: number): Date {
  if (days <= 0) return from
  const d = new Date(from)
  let left = days
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) left--
  }
  return d
}

export const toISODate = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * 還有對外詢問沒回，就不能把任務改成「算是做完了」那一類的狀態。
 *
 * **為什麼**：東西還在外面沒回來，這件事就沒有結束。先結案只會讓那筆詢問
 * 變成沒有人在追的孤兒 —— 任務從清單上消失了，而外面那個單位還在等我們的人催。
 *
 * **哪些算沒回**：還在等（`AWAITING`）、部分回覆（`PARTIAL`）、逾期（`OVERDUE`）。
 * **已回覆不算** —— 問過又收到回覆，那件事就完成了，不該再卡住任務；
 * 不然一張任務只要問過一次就永遠結不了案。
 *
 * **只看這張任務自己的**，不看子任務。子任務會被同一條規則各自擋住，
 * 而父任務的進度本來就是子任務彙總出來的，兩邊都擋等於同一件事擋兩次。
 *
 * 不改狀態、或改成的狀態不算完成，就直接放行 —— 既有資料可能本來就違反
 * （這條規則是後來才定的），那些任務還是要能改標題、換負責人。
 */
export async function assertNoOpenInquiries(
  db: Db, taskId: string, nextStatusKey: string, projectId: string
): Promise<void> {
  const [status] = await db<{ category: string }[]>`
    SELECT category FROM task_status
    WHERE project_id = ${projectId} AND key = ${nextStatusKey}`
  if (status?.category !== 'DONE') return

  const [row] = await db<{ open: number; overdue: number }[]>`
    SELECT count(*) FILTER (WHERE replied_at IS NULL AND (due_date IS NULL OR due_date >= CURRENT_DATE))::int AS open,
           count(*) FILTER (WHERE replied_at IS NULL AND due_date < CURRENT_DATE)::int AS overdue
      FROM task_inquiry
     WHERE task_id = ${taskId}`
  const open = (row?.open ?? 0) + (row?.overdue ?? 0)
  if (open === 0) return

  throw badRequest(
    `還有 ${open} 件對外詢問沒有回覆，這張任務還不能算做完`,
    row && row.overdue > 0
      ? `其中 ${row.overdue} 件已經過了期望回覆日。`
        + '請先登錄回覆，或把那幾筆刪掉，再把狀態改成做完。'
      : '請先登錄回覆，或把那幾筆刪掉，再把狀態改成做完。')
}
