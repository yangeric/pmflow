/**
 * 日期工具 —— 刻意不引進 date-fns / dayjs。
 *
 * 這套系統的日期全都是「不帶時間的日曆日」（YYYY-MM-DD）：任務起訖日、
 * 期望回覆日都是。一旦把它們當成時間點處理，跨時區或跨日光節約時就會
 * 整批位移一天，而那種錯誤在畫面上非常難察覺。
 *
 * 所以這裡的規則是：字串進、字串出，中間需要算術時才轉成 Date，而且一律
 * 固定在當地時間中午 —— 中午離兩邊的日界線都有 12 小時，任何時區位移或
 * 日光節約的一小時跳動都不可能把它推到別天。
 */

/** 從 API 拿到的可能是 '2026-08-01' 或完整 ISO，一律只取前 10 碼 */
export const toYmd = (s: string | null | undefined): string | null =>
  s ? s.slice(0, 10) : null

/** 'YYYY-MM-DD' → Date（當地時間中午） */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

/** Date → 'YYYY-MM-DD' */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export const shiftYmd = (s: string, n: number): string => ymd(addDays(parseYmd(s), n))

/** b - a，以天為單位 */
export function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export const todayYmd = (): string => ymd(new Date())

/**
 * 月曆格子的第一天：該月一號往前推到星期日。
 * 固定回傳 42 格（6 週），月份切換時列數不會忽多忽少造成畫面跳動。
 */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1, 12)
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const

export const monthLabel = (year: number, month: number) => `${year} 年 ${month + 1} 月`

/** 給人看的短日期，例如 8/1 */
export const shortDate = (s: string) => {
  const d = parseYmd(s)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
