import { useMemo, useState } from 'react'
import type { Task, TaskStatus } from '../lib/api'
import { Button, Empty, InquiryBadge, ProblemBadge, cx } from '../components/ui'
import { Avatar } from '../components/Avatar'
import { parseYmd, shiftYmd, shortDate, todayYmd, toYmd, WEEKDAY_LABELS } from '../lib/date'
import { week } from '../strings/week'

/**
 * 週檢視 —— 「這一週有哪些任務在跑、各卡在哪個狀態」一眼看完。
 *
 * 跟行事曆（月格 + 跨日長條）分工不同：月曆回答的是「哪一天有什麼」，
 * 這裡回答的是「這七天之內，我手上這些任務的狀態分布」。所以不畫格子，
 * 直接依狀態分組列出來，掃一遍就知道卡在哪一段。
 *
 * 兩個刻意的取捨：
 * 1. **一週從星期日開始**，跟行事曆的月格（`monthGrid` 從星期日補起）一致 ——
 *    同一張任務在兩個畫面裡不能分屬不同的週。
 * 2. **列的是「期間與這一週有重疊」的任務**，不是只有開始日落在這週的。
 *    跨週的任務這週還在做，看不到它才是真的漏掉東西。
 *    重疊的判斷沿用行事曆那一段（`!(end < 週一天 || start > 週末)`），不另外造一套。
 *
 * 資料由上層傳進來（跟看板、行事曆一樣），這個元件不自己打 API。
 */

const W = week

/** 一列要畫的東西，先算好省得畫的時候到處判斷 */
interface Row {
  task: Task
  /** 正規化之後的期間（只填一邊時兩邊相同），用來排序與判斷重疊 */
  start: string
  end: string
  /** 是不是從上一週就開始了 / 會延續到下一週 */
  fromBefore: boolean
  toAfter: boolean
  /** 已經過了到期日而且狀態還不算完成 */
  overdue: boolean
}

interface Group {
  key: string
  name: string
  color: string
  rows: Row[]
}

export default function WeekView({
  tasks, statuses, onOpen,
}: {
  tasks: Task[]
  statuses: TaskStatus[]
  onOpen: (taskId: string) => void
}) {
  const today = todayYmd()
  /** 目前看的是哪一週，存的是那一週的星期日 */
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today))

  const weekEnd = shiftYmd(weekStart, 6)
  const thisWeekStart = startOfWeek(today)

  const doneKeys = useMemo(
    () => new Set(statuses.filter(s => s.category === 'DONE').map(s => s.key)),
    [statuses]
  )

  // ── 把任務分成「這一週有在跑的」與「根本沒排期的」 ──────
  const { rows, undatedCount } = useMemo(() => {
    const out: Row[] = []
    let undated = 0

    for (const t of tasks) {
      const s = toYmd(t.startDate)
      const e = toYmd(t.dueDate)
      // 兩邊都沒填的不屬於任何一週，只在底下記個數
      if (!s && !e) { undated++; continue }
      const a = s ?? e!
      const b = e ?? s!
      // 資料若反過來（結束早於開始）就把兩端對調，不然重疊判斷會整段落空
      const lo = a <= b ? a : b
      const hi = a <= b ? b : a
      // 跟行事曆同一套：只要沒有「整段在這週之前」或「整段在這週之後」就是有重疊
      if (hi < weekStart || lo > weekEnd) continue
      out.push({
        task: t,
        start: lo,
        end: hi,
        fromBefore: lo < weekStart,
        toAfter: hi > weekEnd,
        overdue: !doneKeys.has(t.statusKey) && hi < today,
      })
    }
    return { rows: out, undatedCount: undated }
  }, [tasks, weekStart, weekEnd, doneKeys, today])

  // ── 依狀態分組。組的順序照 statuses 陣列，不自己排 ────────
  const groups = useMemo(() => {
    const byKey = new Map<string, Row[]>()
    for (const r of rows) {
      const list = byKey.get(r.task.statusKey)
      if (list) list.push(r)
      else byKey.set(r.task.statusKey, [r])
    }

    /*
     * 組內的順序：先開始的排前面，同一天開始的先排先結束的（短的先做完），
     * 最後拿任務編號當定序 —— 沒有這一層的話，同日同長度的兩張任務
     * 每次重畫都可能換位置，看起來像資料在跳。
     */
    const sortRows = (list: Row[]) =>
      list.sort((x, y) =>
        x.start.localeCompare(y.start) ||
        x.end.localeCompare(y.end) ||
        x.task.ref.localeCompare(y.task.ref)
      )

    const out: Group[] = []
    for (const s of statuses) {
      const list = byKey.get(s.key)
      if (!list) continue          // 這一週沒有這個狀態的任務就不畫空組
      out.push({ key: s.key, name: s.name, color: s.color, rows: sortRows(list) })
      byKey.delete(s.key)
    }
    // 指到已經被刪掉的狀態的任務不能就這樣消失，收成最後一組
    const orphan = [...byKey.values()].flat()
    if (orphan.length > 0) {
      out.push({
        key: '__unknown__',
        name: W.unknownStatus,
        color: '#94a3b8',
        rows: sortRows(orphan),
      })
    }
    return out
  }, [rows, statuses])

  const go = (n: number) => setWeekStart(s => shiftYmd(s, n * 7))

  const fromYear = parseYmd(weekStart).getFullYear()
  const toYear = parseYmd(weekEnd).getFullYear()

  return (
    <div className="flex h-full flex-col">

      {/* ── 工具列 ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2
                      dark:border-slate-700 dark:bg-slate-900">
        <Button variant="ghost" onClick={() => go(-1)} aria-label={W.prevWeek}>‹</Button>
        <div className="min-w-[8rem] text-center">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {W.rangeLabel(shortDate(weekStart), shortDate(weekEnd))}
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-400">
            {fromYear === toYear ? W.yearLabel(fromYear) : W.yearSpanLabel(fromYear, toYear)}
          </div>
        </div>
        <Button variant="ghost" onClick={() => go(1)} aria-label={W.nextWeek}>›</Button>
        <Button onClick={() => setWeekStart(thisWeekStart)}>{W.thisWeek}</Button>

        {weekStart === thisWeekStart && (
          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700
                           ring-1 ring-inset ring-blue-600/20
                           dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/30">
            {W.currentBadge}
          </span>
        )}

        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {W.summary(rows.length)}
        </span>
      </div>

      {/* ── 這一週的七天，讓標題那段日期對得上星期幾 ── */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50
                      dark:border-slate-700 dark:bg-slate-900">
        {WEEKDAY_LABELS.map((label, i) => {
          const day = shiftYmd(weekStart, i)
          const isToday = day === today
          return (
            <div key={label}
                 className={cx(
                   'flex items-center justify-center gap-1 py-1.5 text-xs',
                   i === 0 || i === 6
                     ? 'text-slate-400 dark:text-slate-400'
                     : 'text-slate-500 dark:text-slate-400'
                 )}>
              <span className="font-medium">{label}</span>
              <span className={cx(
                'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 tabular-nums',
                isToday && 'bg-blue-600 font-semibold text-white dark:bg-blue-500'
              )}>
                {parseYmd(day).getDate()}
              </span>
            </div>
          )
        })}
      </div>

      {/* ── 任務 ── */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {groups.length === 0 ? (
          <Empty>{W.emptyWeek}</Empty>
        ) : (
          <div className="min-w-[52rem] overflow-hidden rounded-lg bg-white ring-1 ring-slate-200
                          dark:bg-slate-900 dark:ring-slate-700">
            {/* 欄位標題只放一次。每一組再放一次的話，整頁會被標題切碎 */}
            <div className={cx(GRID, 'bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500',
                               'dark:bg-slate-800 dark:text-slate-400')}>
              <span>{W.colTask}</span>
              <span>{W.colAssignee}</span>
              <span>{W.colDates}</span>
              <span>{W.colProgress}</span>
              <span>{W.colInquiry}</span>
            </div>

            {groups.map(g => (
              <section key={g.key}>
                {/* 組標題：狀態色的圓點 + 狀態名稱 + 張數。
                    狀態色是使用者自己挑的，只拿來當圓點，不當底色 —— 深淺不受控 */}
                <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-1.5
                                dark:border-slate-800 dark:bg-slate-800/40">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: g.color }} />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {g.name}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-400">
                    {W.groupCount(g.rows.length)}
                  </span>
                </div>

                {g.rows.map(r => (
                  <TaskRow key={r.task.id} row={r} onOpen={onOpen} />
                ))}
              </section>
            ))}
          </div>
        )}

        {/* 沒有排期的任務不進這個畫面，但一定要講一聲 */}
        {undatedCount > 0 && (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {W.undated(undatedCount)}
          </p>
        )}
      </div>
    </div>
  )
}

/** 五個欄位的寬度，標題列與每一列共用同一份，不然對不齊 */
const GRID = 'grid grid-cols-[minmax(0,1fr)_9rem_14rem_8rem_7rem] items-center gap-3'

// ── 一張任務 ────────────────────────────────────────────
function TaskRow({ row, onOpen }: { row: Row; onOpen: (taskId: string) => void }) {
  const t = row.task
  return (
    <div
      onClick={() => onOpen(t.id)}
      title={W.rowTooltip(t.ref, t.title)}
      className={cx(
        GRID,
        'cursor-pointer border-t border-slate-100 px-3 py-2 text-sm transition-colors',
        'hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800'
      )}
    >
      {/* 任務編號與標題 */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-400">
          {t.ref}
        </span>
        <span className="truncate text-slate-800 dark:text-slate-200">{t.title}</span>
        <ProblemBadge problem={t.problem} />
      </div>

      {/* 負責人 */}
      <div className="min-w-0">
        {t.assigneeName ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-slate-600
                           dark:text-slate-300"
                title={t.assigneeName}>
            <Avatar userId={t.assigneeId} name={t.assigneeName} hasAvatar={t.assigneeHasAvatar} />
            <span className="truncate">{t.assigneeName}</span>
          </span>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-400">{W.unassigned}</span>
        )}
      </div>

      {/* 起訖日。跨到這一週以外時把來龍去脈寫出來 */}
      <div className="min-w-0">
        <div className={cx('truncate text-xs', row.overdue
          ? 'font-medium text-red-600 dark:text-red-400'
          : 'text-slate-500 dark:text-slate-400')}
             title={row.overdue ? W.overdueTip : undefined}>
          {dateText(t)}
        </div>
        {(row.fromBefore || row.toAfter) && (
          <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-400">
            {row.fromBefore && row.toAfter ? W.wholeWeek
              : row.fromBefore ? W.fromBefore
                : W.toAfter}
          </div>
        )}
      </div>

      {/* 進度 */}
      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-slate-200
                         dark:bg-slate-700">
          <span className={cx('block h-full', t.progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                style={{ width: `${t.progress}%` }} />
        </span>
        <span className="tabular-nums">{W.progressLabel(t.progress)}</span>
      </div>

      {/* 發文追蹤 */}
      <div><InquiryBadge state={t.inquiryState} /></div>
    </div>
  )
}

// ── 小工具 ──────────────────────────────────────────────

/**
 * 那一週的星期日。
 *
 * 一律字串進、字串出：`parseYmd` 固定在中午，只用來問「星期幾」，
 * 位移交給 `shiftYmd`，中間不會把日期當成時間點來加減。
 */
function startOfWeek(day: string): string {
  return shiftYmd(day, -parseYmd(day).getDay())
}

/** 起訖日的顯示。只填一邊時要看得出來是哪一邊沒填 */
function dateText(t: Task): string {
  const s = toYmd(t.startDate)
  const e = toYmd(t.dueDate)
  if (s && e) return W.bothDates(shortDate(s), shortDate(e))
  if (s) return W.startOnly(shortDate(s))
  return W.dueOnly(shortDate(e!))
}
