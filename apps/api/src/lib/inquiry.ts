import type { Db } from './db.js'

/**
 * 重算某張任務的發文追蹤彙總欄位。
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
