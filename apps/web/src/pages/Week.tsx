import { useMemo, useState } from 'react'
import type { ProjectParam, Task, TaskStatus } from '../lib/api'
import { Button, Empty, InquiryBadge, ProblemBadge, cx } from '../components/ui'
import { Avatar } from '../components/Avatar'
import { parseYmd, shiftYmd, shortDate, todayYmd, toYmd, WEEKDAY_LABELS } from '../lib/date'
import { useRemembered } from '../lib/remember'
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
  /** 組標題左邊那顆色點。依成員分組時改畫頭像，這裡就是 null */
  color: string | null
  /** 依成員分組時的頭像。未指派那一組帶的是空值，畫出來是灰底的破折號 */
  avatar?: { userId: string | null; name: string | null; hasAvatar: boolean }
  rows: Row[]
  /** 這一組裡逾期的張數。收起來的時候要留在標題上 */
  overdue: number
}

/**
 * 分組方式。
 *
 * 依狀態回答「這禮拜卡在哪一關」，依類型回答「這禮拜是在做事還是在滅火」——
 * 一週裡問題（BUG）佔了半數的話，那件事光看狀態分組是看不出來的。
 * 依成員回答「這禮拜誰身上壓了幾張」—— 負擔集中在誰身上，前兩種都看不出來。
 */
const GROUP_BY = ['status', 'type', 'member'] as const
type GroupBy = typeof GROUP_BY[number]

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  status: W.groupByStatus,
  type: W.groupByType,
  member: W.groupByMember,
}

/** 依成員分組時「沒有人負責」那一組的鍵。用不可能跟使用者編號撞到的寫法 */
const NO_ASSIGNEE = '__unassigned__'

export default function WeekView({
  projectId, tasks, statuses, types, onOpen,
}: {
  /** 只拿來當收合偏好的鍵 —— 狀態是每個專案自己一份，鍵不分專案會互相蓋掉 */
  projectId: string
  tasks: Task[]
  statuses: TaskStatus[]
  /** 這個專案自己的任務類型（0011_project_parameters.sql）。名稱與顏色都是他自己設的 */
  types: ProjectParam[]
  onOpen: (taskId: string) => void
}) {
  const today = todayYmd()
  /** 目前看的是哪一週，存的是那一週的星期日 */
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today))
  /** 目前選取的單一日，null＝看整週 7 天 */
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  /*
   * 收起來的是哪幾組。存的是「收合」而不是「展開」的清單：
   * 專案之後新增狀態時，沒被收過的組一律是展開的 ——
   * 反過來存的話，新狀態一出現就是收著的，而沒有人會想到要去展開一個
   * 自己剛剛才建出來的東西。
   */
  const [collapsed, setCollapsed] = useRemembered<string[]>(`week.collapsed.${projectId}`, [])

  /*
   * 分組方式也記得住，理由跟收合一樣：追問題的人每天都想看類型分組，
   * 每次進來重設成狀態分組，等於逼他每天重按一次。
   *
   * 收合的鍵在兩種分組底下是不同的一組值（狀態鍵 vs 類型鍵），
   * 所以偏好要分開存 —— 共用一份的話，換個分組方式會收起一堆莫名其妙的組。
   */
  /*
   * 存進去的是純字串而不是 `GroupBy`：這個鍵在「依成員」還不存在的時候就在用了，
   * 而且瀏覽器裡的舊值改不動也刪不掉。讀到不認得的字（將來又拿掉某一種分組時
   * 也會發生）就退回預設的依狀態，不要讓一個舊偏好把整頁弄到畫不出來。
   */
  const [savedGroupBy, setGroupBy] = useRemembered<string>(`week.groupBy.${projectId}`, 'status')
  const groupBy: GroupBy =
    (GROUP_BY as readonly string[]).includes(savedGroupBy) ? savedGroupBy as GroupBy : 'status'
  const collapseKey = `${groupBy}:`
  const isCollapsed = (key: string) => collapsed.includes(collapseKey + key)
  const toggleGroup = (key: string) =>
    setCollapsed(isCollapsed(key)
      ? collapsed.filter(k => k !== collapseKey + key)
      : [...collapsed, collapseKey + key])

  /** 類型的中文與顏色由專案自己定；查不到就退回鍵本身，至少看得出來是哪一種 */
  const typeOf = (key: string) => types.find(t => t.key === key)?.name ?? key
  const typeColorOf = (key: string) => types.find(t => t.key === key)?.color ?? '#94a3b8'

  const weekEnd = shiftYmd(weekStart, 6)
  const thisWeekStart = startOfWeek(today)

  const doneKeys = useMemo(
    () => new Set(statuses.filter(s => s.category === 'DONE').map(s => s.key)),
    [statuses]
  )

  // ── 把任務分成「這一週或選定單日有在跑的」與「根本沒排期的」 ──────
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

      // 看單日 vs 看整週
      if (selectedDay) {
        if (lo > selectedDay || hi < selectedDay) continue
      } else {
        if (hi < weekStart || lo > weekEnd) continue
      }

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
  }, [tasks, weekStart, weekEnd, selectedDay, doneKeys, today])

  // ── 分組。組的順序照系統參數的順序，不自己排 ──────────────
  const groups = useMemo(() => {
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

    const countOverdue = (list: Row[]) => list.filter(r => r.overdue).length

    /*
     * 依成員：組不是照系統參數的清單排，而是照這一週實際有任務的人 ——
     * 專案成員可能有二十個，這一週動到的只有三個，把沒有任務的人也列出來
     * 只會逼人一直往下捲。所以這裡不吃 `statuses` / `types` 那條路，
     * 直接從任務身上的負責人收出來，照顯示名稱排，未指派固定收在最後。
     */
    if (groupBy === 'member') {
      const byMember = new Map<string, { name: string | null; hasAvatar: boolean; rows: Row[] }>()
      for (const r of rows) {
        const id = r.task.assigneeId ?? NO_ASSIGNEE
        const g = byMember.get(id)
        if (g) g.rows.push(r)
        else byMember.set(id, {
          name: r.task.assigneeName, hasAvatar: r.task.assigneeHasAvatar, rows: [r],
        })
      }

      const named: Group[] = []
      for (const [id, g] of byMember) {
        if (id === NO_ASSIGNEE) continue
        named.push({
          key: id,
          // 有編號卻讀不到名字（人被移出專案了）也要看得到，不能讓那幾張任務消失
          name: g.name ?? W.unknownAssignee,
          color: null,
          avatar: { userId: id, name: g.name, hasAvatar: g.hasAvatar },
          rows: sortRows(g.rows),
          overdue: countOverdue(g.rows),
        })
      }
      named.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))

      /*
       * 沒有人負責的那一組一定要畫，而且排在最後：
       * 它不屬於任何人，夾在人與人中間會被當成某個人的組；
       * 但它也最需要被看到 —— 藏起來就沒有人會去認領。
       */
      const none = byMember.get(NO_ASSIGNEE)
      if (none) named.push({
        key: NO_ASSIGNEE,
        name: W.groupUnassigned,
        color: null,
        avatar: { userId: null, name: null, hasAvatar: false },
        rows: sortRows(none.rows),
        overdue: countOverdue(none.rows),
      })
      return named
    }

    /*
     * 依狀態與依類型共用同一段程式：差別只有「一張任務歸到哪個鍵」與
     * 「組要照哪一份清單排」。分成兩份的話，排序、逾期計數、
     * 找不到對應值的那一組，三件事都要各維護一次。
     */
    const keyOf = (r: Row) => groupBy === 'type' ? r.task.type : r.task.statusKey
    const order: Array<{ key: string; name: string; color: string }> =
      groupBy === 'type' ? types : statuses

    const byKey = new Map<string, Row[]>()
    for (const r of rows) {
      const list = byKey.get(keyOf(r))
      if (list) list.push(r)
      else byKey.set(keyOf(r), [r])
    }

    const out: Group[] = []
    for (const s of order) {
      const list = byKey.get(s.key)
      if (!list) continue          // 這一週沒有這一組的任務就不畫空組
      out.push({
        key: s.key, name: s.name, color: s.color,
        rows: sortRows(list), overdue: countOverdue(list),
      })
      byKey.delete(s.key)
    }
    // 指到已經被刪掉的狀態或類型的任務不能就這樣消失，收成最後一組
    const orphan = [...byKey.values()].flat()
    if (orphan.length > 0) {
      out.push({
        key: '__unknown__',
        name: groupBy === 'type' ? W.unknownType : W.unknownStatus,
        color: '#94a3b8',
        rows: sortRows(orphan),
        overdue: countOverdue(orphan),
      })
    }
    return out
  }, [rows, statuses, types, groupBy])

  /** 全部收合／全部展開。已經全收起來時，那顆按鈕改成展開，不然按了沒有反應 */
  const allCollapsed = groups.length > 0 && groups.every(g => isCollapsed(g.key))

  const go = (n: number) => setWeekStart(s => shiftYmd(s, n * 7))

  const fromYear = parseYmd(weekStart).getFullYear()
  const toYear = parseYmd(weekEnd).getFullYear()

  return (
    <div className="flex h-full flex-col">

      {/* ── 工具列 ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2
                      dark:border-slate-700 dark:bg-slate-900">
        <Button variant="ghost" onClick={() => { setSelectedDay(null); go(-1) }} aria-label={W.prevWeek}>‹</Button>
        <div className="min-w-[8rem] text-center">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {W.rangeLabel(shortDate(weekStart), shortDate(weekEnd))}
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-400">
            {fromYear === toYear ? W.yearLabel(fromYear) : W.yearSpanLabel(fromYear, toYear)}
          </div>
        </div>
        <Button variant="ghost" onClick={() => { setSelectedDay(null); go(1) }} aria-label={W.nextWeek}>›</Button>
        <Button onClick={() => { setSelectedDay(null); setWeekStart(thisWeekStart) }}>{W.thisWeek}</Button>

        {weekStart === thisWeekStart && !selectedDay && (
          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700
                           ring-1 ring-inset ring-blue-600/20
                           dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/30">
            {W.currentBadge}
          </span>
        )}

        {selectedDay && (
          <div className="flex items-center gap-1">
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800
                             dark:bg-blue-500/20 dark:text-blue-200">
              {W.filterSingleDay(shortDate(selectedDay))}
            </span>
            <Button variant="ghost" className="text-xs" onClick={() => setSelectedDay(null)}>
              {W.allWeek}
            </Button>
          </div>
        )}

        {/* 分組方式。放在工具列右半邊，跟左邊「看哪一週」分開 ——
            一個是換時間，一個是換排法，混在一起按錯的機會很高 */}
        <div className="ml-auto flex items-center gap-1">
          <span className="text-xs text-slate-500 dark:text-slate-400">{W.groupByLabel}</span>
          {GROUP_BY.map(g => (
            <button key={g} type="button" onClick={() => setGroupBy(g)}
                    aria-pressed={groupBy === g}
                    className={cx(
                      'rounded px-2 py-1 text-xs transition-colors',
                      groupBy === g
                        ? 'bg-blue-50 font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20 ' +
                          'dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/30'
                        : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                    )}>
              {GROUP_BY_LABEL[g]}
            </button>
          ))}
        </div>

        {/* 一組都沒有的時候不畫這顆 —— 按了不會有任何事情發生的按鈕不要出現 */}
        {groups.length > 0 && (
          <Button variant="ghost"
                  onClick={() => setCollapsed(allCollapsed
                    ? collapsed.filter(k => !k.startsWith(collapseKey))
                    : [
                      ...collapsed.filter(k => !k.startsWith(collapseKey)),
                      ...groups.map(g => collapseKey + g.key),
                    ])}>
            {allCollapsed ? W.expandAll : W.collapseAll}
          </Button>
        )}

        <span className="text-xs text-slate-500 dark:text-slate-400">
          {selectedDay ? W.singleDaySummary(shortDate(selectedDay), rows.length) : W.summary(rows.length)}
        </span>
      </div>

      {/* ── 這一週的七天，讓標題那段日期對得上星期幾（可點選切換單日視角） ── */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50
                      dark:border-slate-700 dark:bg-slate-900">
        {WEEKDAY_LABELS.map((label, i) => {
          const day = shiftYmd(weekStart, i)
          const isToday = day === today
          const isSelected = day === selectedDay
          return (
            <button key={label}
                 type="button"
                 title={W.dayTip(shortDate(day))}
                 onClick={() => setSelectedDay(prev => prev === day ? null : day)}
                 className={cx(
                   'flex items-center justify-center gap-1 py-1.5 text-xs transition-colors cursor-pointer',
                   isSelected
                     ? 'bg-blue-100/80 font-semibold text-blue-800 border-b-2 border-blue-600 dark:bg-blue-500/20 dark:text-blue-200 dark:border-blue-400'
                     : 'hover:bg-slate-100 dark:hover:bg-slate-800',
                   !isSelected && (i === 0 || i === 6
                     ? 'text-slate-400 dark:text-slate-400'
                     : 'text-slate-500 dark:text-slate-400')
                 )}>
              <span className="font-medium">{label}</span>
              <span className={cx(
                'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 tabular-nums',
                isToday && !isSelected && 'bg-blue-600 font-semibold text-white dark:bg-blue-500',
                isSelected && 'bg-blue-600 font-bold text-white dark:bg-blue-500'
              )}>
                {parseYmd(day).getDate()}
              </span>
            </button>
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

            {groups.map(g => {
              const off = isCollapsed(g.key)
              return (
                <section key={g.key}>
                  {/* 組標題：色點 + 名稱 + 張數。整條都可以按，不是只有那個箭頭 ——
                      要按中一個 12px 的三角形是件很煩的事。
                      色是使用者自己挑的，只拿來當圓點，不當底色（深淺不受控） */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={!off}
                    aria-label={off ? W.expandGroup(g.name) : W.collapseGroup(g.name)}
                    className="flex w-full items-center gap-2 border-t border-slate-100 bg-slate-50/60
                               px-3 py-1.5 text-left transition-colors hover:bg-slate-100
                               dark:border-slate-800 dark:bg-slate-800/40 dark:hover:bg-slate-800"
                  >
                    <span aria-hidden
                          className={cx('shrink-0 text-[10px] text-slate-400 transition-transform',
                                        'dark:text-slate-400', off && '-rotate-90')}>
                      ▼
                    </span>
                    {/* 依成員分組時左邊那格改畫頭像 —— 顏色點代表的是「狀態／類型」，
                        人要用臉來認才快 */}
                    {g.avatar ? (
                      <Avatar userId={g.avatar.userId} name={g.avatar.name}
                              hasAvatar={g.avatar.hasAvatar} />
                    ) : (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: g.color ?? undefined }} />
                    )}
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {g.name}
                    </span>
                    <span className="text-xs text-slate-400 dark:text-slate-400">
                      {W.groupCount(g.rows.length)}
                    </span>
                    {/* 收起來的時候逾期要留在標題上 —— 收合是「現在不看細節」，
                        不是「這些事可以不管」 */}
                    {off && g.overdue > 0 && (
                      <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium
                                       text-red-700 ring-1 ring-inset ring-red-600/20
                                       dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30">
                        {W.groupOverdue(g.overdue)}
                      </span>
                    )}
                  </button>

                  {!off && g.rows.map(r => (
                    <TaskRow key={r.task.id} row={r} onOpen={onOpen}
                             typeName={typeOf(r.task.type)} typeColor={typeColorOf(r.task.type)} />
                  ))}
                </section>
              )
            })}
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
function TaskRow({ row, onOpen, typeName, typeColor }: {
  row: Row
  onOpen: (taskId: string) => void
  /** 這是任務還是問題。看板與清單都標了，週檢視不標的話同一張任務在三個畫面長得不一樣 */
  typeName: string
  typeColor: string
}) {
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
      {/* 類型、任務編號與標題。
          類型色是使用者自己挑的，只當左邊那條細槓，不當底色也不當文字色 ——
          深淺不受控，拿去當底色在深色模式下會有一半讀不到 */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded
                         bg-slate-100 py-0.5 pr-1.5 pl-1 text-[11px] text-slate-600
                         dark:bg-slate-800 dark:text-slate-300">
          <span className="h-3 w-0.5 rounded-full" style={{ background: typeColor }} />
          {typeName}
        </span>
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

      {/* 對外詢問 */}
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
