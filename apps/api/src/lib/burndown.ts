import { sql } from './db.js'

/**
 * 燃盡圖的資料來源：把 `activity` 裡的狀態變更**正向重播**一次，
 * 回推「每一天結束時，每張任務做完了沒」。
 *
 * 為什麼是回推而不是每天存一張快照：這個系統沒有背景排程器（見 CODEMAP），
 * 沒有人半夜幫忙照相；而且真做了快照，漏跑一天就是一個永遠補不回來的洞，
 * 停機一週的圖會直接斷掉。重播的代價是「紀錄有洞時只能用估的」——
 * 那比假裝有資料誠實，估出來的張數會一路回報到畫面上（estimatedCount）。
 *
 * 重播讀得到什麼，取決於 routes/tasks.ts 寫了什麼：
 *   CREATED       body 帶 statusKey  → 初始狀態
 *   FIELD_CHANGE  body 帶 statusKey + statusKeyBefore → 一次轉換
 * 拖曳看板（POST /tasks/:id/move）以前完全不寫紀錄，那段期間的資料一定有洞，
 * 下面兩條補救規則就是為它們準備的。
 */

export type DashboardMetric = 'count' | 'hours'

/** 區間上限。366 天＝含閏年的一整年；再長的圖一格不到一個像素，畫了也讀不出東西 */
export const MAX_RANGE_DAYS = 366

// ── 日期小工具 ────────────────────────────────────────────
//
// 這裡的日期一律是 `YYYY-MM-DD` 字串，只在「加減天數、問星期幾」時借用
// Date，而且**固定走 UTC**（`T00:00:00Z` 進、`toISOString()` 出）。
// 為什麼不能用本地時間：容器的 TZ 是 Asia/Taipei，`new Date('2026-08-05')`
// 之後再用 getDate()／toLocaleDateString() 取值，會整批位移一天。
// 全程 UTC 進出就只是「把字串當成日曆上的格子在數」，不涉及時區。
//
// 兩支儀表板端點共用，放在這裡是因為它們只服務儀表板；
// 前端顯示用的日期工具在 web/src/lib/date.ts，那是另一回事。

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** to - from，單位是天。同一天是 0 */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

export function isWeekend(date: string): boolean {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay()
  return dow === 0 || dow === 6
}

/** 含頭含尾。to 比 from 早就回空陣列（呼叫端不必再防一次） */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * 工作日天數（週一～週五），含頭含尾。
 *
 * 不逐日跑迴圈是因為任務的區間可能遠比畫面上的區間長 ——
 * 攤平工時時要除的是「整段的工作日」，不是看得到的那幾天，
 * 否則跨出視窗的任務會被攤成好幾倍。
 */
export function countWorkdays(from: string, to: string): number {
  const days = daysBetween(from, to) + 1
  if (days <= 0) return 0
  let n = Math.floor(days / 7) * 5
  let dow = new Date(from + 'T00:00:00Z').getUTCDay()
  for (let i = days % 7; i > 0; i--) {
    if (dow !== 0 && dow !== 6) n++
    dow = (dow + 1) % 7
  }
  return n
}

/** 反過來的區間收成一天，太長的截掉尾巴 —— 兩者都不該讓端點直接爆掉 */
export function clampRange(from: string, to: string): { from: string; to: string } {
  if (to < from) return { from, to: from }
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    return { from, to: addDays(from, MAX_RANGE_DAYS - 1) }
  }
  return { from, to }
}

/**
 * 「今天」一律問資料庫，不用 Node 的 new Date()。
 *
 * 整份程式判斷逾期用的是 `CURRENT_DATE`（見 lib/inquiry.ts），
 * 而任務的日期是靠 `created_at::date` 分桶的 —— 兩者都跟著資料庫的時區走。
 * 這裡自己算一份的話，容器的 TZ 只要有一邊沒設對，圖上的「今天」就會跟
 * 逾期判斷差一天，而那種錯誤在畫面上幾乎看不出來。
 */
export async function currentDate(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`
    SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`
  return row.today
}

// ── 燃盡 ──────────────────────────────────────────────────

export interface BurndownPoint {
  date: string
  remaining: number | null
  total: number | null
  done: number | null
  ideal: number
  isFuture: boolean
  isWeekend: boolean
  isToday: boolean
}

export interface BurndownResult {
  points: BurndownPoint[]
  taskCount: number
  estimatedCount: number
}

interface TaskRow {
  id: string
  statusKey: string
  createdDate: string
  updatedDate: string
  estimateHours: number
}

interface StatusEvent {
  taskId: string
  kind: 'CREATED' | 'FIELD_CHANGE'
  date: string
  statusKey: string
  statusKeyBefore: string | null
}

/** 一張任務的狀態變化序列。每一段從 date 當天開始生效，一直到下一段為止 */
interface Timeline {
  createdDate: string
  estimateHours: number
  segments: Array<{ date: string; done: boolean }>
  /** 完成時間是估出來的（紀錄有洞），要誠實回報給看圖的人 */
  estimated: boolean
}

/**
 * 算出區間內每一天的剩餘量。
 *
 * `today` 由呼叫端傳進來（見 currentDate 的說明）—— 一次請求裡的「今天」
 * 只能有一個答案，讓每個函式各問一次的話，跨午夜的請求會自相矛盾。
 */
export async function computeBurndown(
  projectId: string,
  opts: { from: string; to: string; today: string; metric: DashboardMetric }
): Promise<BurndownResult> {
  const { from, to, today, metric } = opts

  /*
   * 排除大項目（EPIC）。它是一個容器，底下的每一件事都已經各自算過一次，
   * 把它也算進來等於每件事被算兩次，而且它的「完成」只是子任務的結論，
   * 不是誰真的做完了什麼。
   */
  const tasks = await sql<TaskRow[]>`
    SELECT t.id, t.status_key AS "statusKey",
           to_char(t.created_at::date, 'YYYY-MM-DD') AS "createdDate",
           to_char(t.updated_at::date, 'YYYY-MM-DD') AS "updatedDate",
           coalesce(t.estimate_hours, 0)::float8 AS "estimateHours"
    FROM task t
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.type <> 'EPIC'`

  if (!tasks.length) return { points: [], taskCount: 0, estimatedCount: 0 }

  // 「做完了沒」看狀態欄的分類，不是看 key —— 狀態欄是每個專案自己定義的，
  // 有人叫 done、有人叫 verified，甚至叫「結案」。分類是唯一跨專案通用的東西。
  const statuses = await sql<{ key: string; category: string }[]>`
    SELECT key, category FROM task_status WHERE project_id = ${projectId} ORDER BY rank`
  const doneKeys = new Set(statuses.filter(s => s.category === 'DONE').map(s => s.key))
  const firstStatusKey = statuses[0]?.key ?? 'todo'
  const isDone = (key: string) => doneKeys.has(key)

  /*
   * 只撈得出 statusKey 的那幾種紀錄。用 `body->>'statusKey' IS NOT NULL` 而不是
   * jsonb 的存在運算子，是為了把 reassign、改標題那些同樣是 FIELD_CHANGE 的
   * 紀錄擋在外面 —— 它們的 body 裡根本沒有這個鍵。
   */
  const events = await sql<StatusEvent[]>`
    SELECT a.task_id AS "taskId", a.kind,
           to_char(a.created_at::date, 'YYYY-MM-DD') AS "date",
           a.body->>'statusKey' AS "statusKey",
           a.body->>'statusKeyBefore' AS "statusKeyBefore"
    FROM activity a
    JOIN task t ON t.id = a.task_id
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
      AND a.kind IN ('CREATED', 'FIELD_CHANGE')
      AND a.body->>'statusKey' IS NOT NULL
    ORDER BY a.created_at`

  const byTask = new Map<string, StatusEvent[]>()
  for (const e of events) {
    const list = byTask.get(e.taskId)
    if (list) list.push(e)
    else byTask.set(e.taskId, [e])
  }

  const timelines = tasks.map(t => replay(t, byTask.get(t.id) ?? [], firstStatusKey, isDone))
  const estimatedCount = timelines.filter(t => t.estimated).length

  // 一張任務算多少：張數就是 1，工時就是預估工時（沒填當 0）
  const weight = (t: Timeline) => (metric === 'hours' ? t.estimateHours : 1)

  const days = eachDay(from, to)
  const totals: number[] = []
  const dones: number[] = []

  for (const date of days) {
    let total = 0
    let done = 0
    for (const t of timelines) {
      // 那天還沒開這張任務，它就還不在圖上 —— 中途才加的事會讓總量往上跳，
      // 那正是燃盡圖最該讓人看見的一件事，不能事後抹平
      if (t.createdDate > date) continue
      const w = weight(t)
      total += w
      if (doneAt(t, date)) done += w
    }
    totals.push(total)
    dones.push(done)
  }

  /*
   * 理想線從「第一天真的有任務」開始降，不是從區間的第一天。
   *
   * 區間常常從專案的起始日算起，而事情是後來才開進系統的。從第一天就
   * 開始降的話，那幾天的參考線會說「你已經該做完 1 張了」—— 但那時候
   * 系統裡一張任務都還沒有，那句話沒有對象。所以第一張任務出現之前
   * 一律水平，從它出現那天才開始往下走。
   *
   * 起點的量取「第一天有任務」那天的總量（也就是最初的範圍），
   * 中途才追加的事刻意不併進參考線 —— 參考線要能被超出，
   * 跟著實際範圍一起長高的話，永遠不會顯示落後。
   */
  const baseIdx = Math.max(0, totals.findIndex(v => v > 0))
  const baseTotal = totals[baseIdx] ?? 0
  /** 從起點到區間結束還有幾天可以燒 */
  const burnSpan = days.length - 1 - baseIdx

  const points = days.map((date, i) => {
    const isFuture = date > today
    return {
      date,
      // 未來沒有實際值。補 0 或延用今天的數字都會被讀成「已經量到了」
      remaining: isFuture ? null : round2(totals[i] - dones[i]),
      total: isFuture ? null : round2(totals[i]),
      done: isFuture ? null : round2(dones[i]),
      /*
       * 參考線不是資料，未來的日子也要有值（否則圖的右半邊沒有東西可以比）。
       * 第一張任務出現之前一律水平；起點之後才線性降到最後一天的 0。
       * 起點就是最後一天（或只有一天的區間）時，「今天要做完全部」
       * 不是一句有意義的話，直接讓它等於總量。
       */
      ideal: round2(i <= baseIdx || burnSpan <= 0
        ? baseTotal
        : (baseTotal * (burnSpan - (i - baseIdx))) / burnSpan),
      isFuture,
      isWeekend: isWeekend(date),
      isToday: date === today,
    }
  })

  return { points, taskCount: timelines.length, estimatedCount }
}

/**
 * 正向重播一張任務的狀態。
 *
 * 初始狀態依序找三個地方：CREATED 記下的狀態 → 最早那筆變更的「變更前」→
 * 專案狀態欄的第一欄。越後面越是猜的，但總比讓整條線從空的開始好。
 */
function replay(
  task: TaskRow, events: StatusEvent[], firstStatusKey: string,
  isDone: (key: string) => boolean
): Timeline {
  const initial = events.find(e => e.kind === 'CREATED')?.statusKey
    ?? events[0]?.statusKeyBefore
    ?? firstStatusKey

  // 任務不可能在建立之前就被改過狀態。真的出現這種資料（例如示範資料
  // 回填日期時對不齊），以較早的那個為準，不然那幾筆變更會被丟掉
  const createdDate = events.length && events[0].date < task.createdDate
    ? events[0].date
    : task.createdDate

  const seq: Array<{ date: string; statusKey: string }> = [
    { date: createdDate, statusKey: initial },
  ]
  for (const e of events) {
    if (e.kind === 'CREATED') continue
    const last = seq[seq.length - 1]
    if (last.statusKey === e.statusKey) continue   // 沒真的變就不佔一段
    seq.push({ date: e.date < createdDate ? createdDate : e.date, statusKey: e.statusKey })
  }

  // 整條序列裡有沒有出現過「進入完成」這件事。**建立時就是完成也算** ——
  // 那樣至少知道是哪一天，不需要再估
  const enteredDone = seq.some(
    (s, i) => isDone(s.statusKey) && (i === 0 || !isDone(seq[i - 1].statusKey)))

  /*
   * 兩條補救規則，順序不能顛倒：
   *
   *  1. 現在是完成、但從頭到尾查不到那一次轉換（多半是拖曳看板留下的洞）——
   *     只好把「最後更新時間」當成完成時間。
   *  2. 重播出來的最終狀態跟現況對不上 —— 以現況為準修正最後一段。
   *
   * 先做 2 的話會把最後一段直接改成完成，第 1 條就永遠不會成立，
   * 完成日會被記到「最後一筆有紀錄的變更」那天，比實際早很多。
   */
  let estimated = false
  if (isDone(task.statusKey) && !enteredDone) {
    const last = seq[seq.length - 1]
    seq.push({
      date: task.updatedDate > last.date ? task.updatedDate : last.date,
      statusKey: task.statusKey,
    })
    estimated = true
  } else if (seq[seq.length - 1].statusKey !== task.statusKey) {
    seq[seq.length - 1].statusKey = task.statusKey
    estimated = true
  }

  return {
    createdDate,
    estimateHours: task.estimateHours,
    segments: seq.map(s => ({ date: s.date, done: isDone(s.statusKey) })),
    estimated,
  }
}

/** 那天結束時做完了沒：往回找最後一段生效日不晚於那天的狀態 */
function doneAt(t: Timeline, date: string): boolean {
  for (let i = t.segments.length - 1; i >= 0; i--) {
    if (t.segments[i].date <= date) return t.segments[i].done
  }
  return false
}

/** 工時攤平之後小數會很長，回到畫面上只會變成一排看不完的數字 */
export const round2 = (n: number) => Math.round(n * 100) / 100
