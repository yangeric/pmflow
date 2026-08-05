import { useMemo, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Api, ApiError,
  type Inquiry, type InquiryState, type Leave, type LeaveType, type Task, type TaskStatus,
} from '../lib/api'
import { Button, Empty, Field, Input, Select, cx, textOnColor } from '../components/ui'
import { useAuth } from '../lib/auth'
import { T } from '../strings'
import { useRemembered } from '../lib/remember'
import {
  WEEKDAY_LABELS, diffDays, monthGrid, monthLabel, parseYmd,
  shiftYmd, shortDate, todayYmd, toYmd, ymd,
} from '../lib/date'

/**
 * 行事曆 —— 自己畫的月曆格，沒有引進 react-big-calendar。
 *
 * 規格書 §4.3 原本寫的是 react-big-calendar，改掉的理由有三個：
 * 1. 它的拖曳外掛要另外帶 react-dnd，而這個專案的拖曳已經統一在 dnd-kit
 *    上（看板、清單排序都是）。同一份 UI 裡兩套拖曳引擎會互相搶指標事件。
 * 2. 它預設的月份、星期、"more" 全是英文，要中文化得逐鍵覆蓋 messages 與
 *    localizer；而使用者明確要求介面不出現英文。
 * 3. 少一個相依就少一個授權風險 —— 這個專案的 CI 有授權白名單關卡。
 *
 * 需要的功能其實只有「月格 + 跨日長條 + 拖曳改期」，自己畫大約兩百行，
 * 換來完全可控的中文介面與零新增相依。
 *
 * 排版：一週一列，列內用絕對定位疊長條（lane packing），不是把事件塞進
 * 每個日格 —— 塞進日格的話跨日任務會被切成看起來無關的好幾塊。
 */

const C = T.calendar

/** 一週最多疊幾條，超過的收成「還有 N 筆」 */
const MAX_LANES = 4
const LANE_H = 20      // px，含間距
const DATE_ROW_H = 24  // px，日期數字那一行

type Piece =
  | {
      kind: 'task'
      key: string
      taskId: string
      title: string
      ref: string
      start: string
      end: string
      days: number
      color: string
      overdue: boolean
      inquiryState: InquiryState
    }
  | {
      kind: 'inquiry'
      key: string
      inquiryId: string
      taskId: string
      title: string
      unit: string
      day: string
      status: Inquiry['status']
    }
  // 請假跟任務走同一套 lane packing，但**不可以拖曳改期** ——
  // 改假要走表單（起訖日、假別、備註是一起改的），
  // 所以它不掛 useDraggable，也不會被 onDragEnd 收到。
  | {
      kind: 'leave'
      key: string
      leave: Leave
      start: string
      end: string
      days: number
    }

type Segment = { piece: Piece; startCol: number; endCol: number; lane: number }

/** 請假表單的內容。空字串的 userId 代表「填自己的」，送出時不帶 userId */
interface LeaveForm {
  /** 有值就是在改既有的那一筆 */
  id: string | null
  userId: string
  userName: string
  leaveType: LeaveType
  startDate: string
  endDate: string
  note: string
}

const LEAVE_TYPE_KEYS: LeaveType[] =
  ['PERSONAL', 'SICK', 'ANNUAL', 'OFFICIAL', 'MARRIAGE', 'BEREAVEMENT', 'OTHER']

export default function CalendarView({
  projectId, workspaceId, tasks, statuses, onOpen,
}: {
  projectId: string
  workspaceId: string
  tasks: Task[]
  statuses: TaskStatus[]
  onOpen: (id: string) => void
}) {
  const qc = useQueryClient()
  const { user: me } = useAuth()
  const today = todayYmd()
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  // 「我想看什麼」是長期偏好，不是這次瀏覽的暫時狀態 —— 每次回來都重勾很煩
  const [showTasks, setShowTasks] = useRemembered('calendar.tasks', true)
  const [showInquiries, setShowInquiries] = useRemembered('calendar.inquiries', true)
  const [showLeaves, setShowLeaves] = useRemembered('calendar.leaves', true)
  const [dragging, setDragging] = useState<Piece | null>(null)
  /** 有值就是請假表單開著。null 代表關著 */
  const [leaveForm, setLeaveForm] = useState<LeaveForm | null>(null)

  // 月曆格先算出來 —— 請假是按「看得到的那六週」去要的，所以要先有格子
  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])
  const gridYmd = useMemo(() => grid.map(ymd), [grid])

  // 對外詢問是工作區層級的端點，這裡只取這個專案的
  const { data: board } = useQuery({
    queryKey: ['inquiry-board', workspaceId],
    queryFn: () => Api.inquiryBoard(workspaceId),
    enabled: !!workspaceId,
  })
  const inquiries = useMemo(
    () => (board?.inquiries ?? []).filter(i => i.projectId === projectId),
    [board, projectId]
  )

  /**
   * 請假是工作區層級的（不分專案）—— 同一個人請的假，在哪個專案看都是同一段。
   *
   * 只要目前這六週的範圍：換月就重抓，換來的是不必一次把整年的假都拉下來。
   * 後端比的是「有沒有重疊」，所以跨月的假在後半個月一樣看得到。
   */
  const leaveRange = { from: gridYmd[0], to: gridYmd[41] }
  const { data: leaveData, isError: leaveFailed } = useQuery({
    queryKey: ['leaves', workspaceId, leaveRange.from, leaveRange.to],
    queryFn: () => Api.leaves(workspaceId, leaveRange),
    enabled: !!workspaceId,
  })
  // useMemo 是為了讓下面攤平片段的 useMemo 有個穩定的依賴，不然每次繪製都重算
  const leaves = useMemo(() => leaveData?.leaves ?? [], [leaveData])
  /** 工作區管理者才能幫別人登記、改別人的假 */
  const canManageLeaves = leaveData?.canManage ?? false

  const statusColor = useMemo(() => {
    const m = new Map(statuses.map(s => [s.key, s.color]))
    return (key: string) => m.get(key) ?? '#94a3b8'
  }, [statuses])

  const doneKeys = useMemo(
    () => new Set(statuses.filter(s => s.category === 'DONE').map(s => s.key)),
    [statuses]
  )

  // ── 把任務與詢問單攤平成「有日期的片段」 ──────────────
  const { pieces, undated } = useMemo(() => {
    const out: Piece[] = []
    const none: Task[] = []

    for (const t of tasks) {
      const s = toYmd(t.startDate)
      const e = toYmd(t.dueDate)
      if (!s && !e) { none.push(t); continue }
      const start = s ?? e!
      const end = e ?? s!
      // 資料若反過來（結束早於開始）就當成單日，畫成負寬度會整列爆版
      const lo = start <= end ? start : end
      const hi = start <= end ? end : start
      out.push({
        kind: 'task',
        key: `task:${t.id}`,
        taskId: t.id,
        title: t.title,
        ref: t.ref,
        start: lo,
        end: hi,
        days: diffDays(parseYmd(lo), parseYmd(hi)) + 1,
        color: statusColor(t.statusKey),
        overdue: !doneKeys.has(t.statusKey) && hi < today,
        inquiryState: t.inquiryState,
      })
    }

    for (const i of inquiries) {
      const d = toYmd(i.dueDate)
      if (!d) continue
      out.push({
        kind: 'inquiry',
        key: `inq:${i.id}`,
        inquiryId: i.id,
        taskId: i.taskId,
        title: i.taskTitle,
        unit: i.askedToUnit,
        day: d,
        status: i.status,
      })
    }
    for (const l of leaves) {
      // 天數用後端算好的（含頭含尾），不要在這裡重算 —— 兩邊差一天就對不起來
      out.push({
        kind: 'leave',
        key: `leave:${l.id}`,
        leave: l,
        start: l.startDate,
        end: l.endDate,
        days: l.days,
      })
    }
    return { pieces: out, undated: none }
  }, [tasks, inquiries, leaves, statusColor, doneKeys, today])

  const visiblePieces = useMemo(
    () => pieces.filter(p =>
      p.kind === 'task' ? showTasks
        : p.kind === 'inquiry' ? showInquiries
          : showLeaves),
    [pieces, showTasks, showInquiries, showLeaves]
  )

  // ── 每週各自做 lane packing ───────────────────────────
  const weeks = useMemo(() => {
    return Array.from({ length: 6 }, (_, w) => {
      const days = gridYmd.slice(w * 7, w * 7 + 7)
      const from = days[0]
      const to = days[6]

      const raw = visiblePieces
        .map(p => {
          // 期望回覆日是單日，任務與請假都是區間
          const s = p.kind === 'inquiry' ? p.day : p.start
          const e = p.kind === 'inquiry' ? p.day : p.end
          if (e < from || s > to) return null
          return {
            piece: p,
            startCol: Math.max(0, days.indexOf(s < from ? from : s)),
            endCol: Math.max(0, days.indexOf(e > to ? to : e)),
          }
        })
        .filter((x): x is { piece: Piece; startCol: number; endCol: number } => x !== null)
        // 先長後短、同長度依開始日 —— 長條先卡位，短的填空隙，視覺上比較穩
        .sort((a, b) =>
          (b.endCol - b.startCol) - (a.endCol - a.startCol) ||
          a.startCol - b.startCol ||
          a.piece.key.localeCompare(b.piece.key)
        )

      const lanes: boolean[][] = []
      const segments: Segment[] = []
      for (const r of raw) {
        let lane = 0
        for (;; lane++) {
          lanes[lane] ??= Array(7).fill(false)
          if (lanes[lane].slice(r.startCol, r.endCol + 1).every(x => !x)) break
        }
        for (let c = r.startCol; c <= r.endCol; c++) lanes[lane][c] = true
        segments.push({ ...r, lane })
      }

      // 超過 MAX_LANES 的收起來，逐日統計被藏掉幾筆
      const shown = segments.filter(s => s.lane < MAX_LANES)
      const hiddenPerDay = Array(7).fill(0) as number[]
      for (const s of segments) {
        if (s.lane < MAX_LANES) continue
        for (let c = s.startCol; c <= s.endCol; c++) hiddenPerDay[c]++
      }
      const laneCount = Math.min(Math.max(...segments.map(s => s.lane + 1), 1), MAX_LANES)
      return { days, segments: shown, hiddenPerDay, laneCount }
    })
  }, [gridYmd, visiblePieces])

  // ── 改期 ──────────────────────────────────────────────
  const reschedule = useMutation({
    mutationFn: ({ id, startDate, dueDate }: { id: string; startDate: string; dueDate: string }) =>
      Api.rescheduleTask(id, { startDate, dueDate, cascade: true }),
    onMutate: async ({ id, startDate, dueDate }) => {
      // 樂觀更新：拖完立刻定位，不要等一次往返才動
      await qc.cancelQueries({ queryKey: ['tasks', projectId] })
      const prev = qc.getQueryData<{ tasks: Task[] }>(['tasks', projectId])
      qc.setQueryData<{ tasks: Task[] }>(['tasks', projectId], old =>
        old ? { tasks: old.tasks.map(t => (t.id === id ? { ...t, startDate, dueDate } : t)) } : old
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['tasks', projectId], ctx.prev)
    },
    onSettled: () => {
      // 排程會連動前後置任務，甘特與關聯圖都要一起失效
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      qc.invalidateQueries({ queryKey: ['schedule', projectId] })
      qc.invalidateQueries({ queryKey: ['graph', projectId] })
    },
  })

  const moveInquiry = useMutation({
    mutationFn: ({ id, dueDate }: { id: string; dueDate: string }) =>
      Api.patchInquiry(id, { dueDate }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['inquiry-board', workspaceId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  // ── 請假的存與刪 ──────────────────────────────────────
  // 這裡不做樂觀更新：請假不是拖出來的，是按了儲存才變的，
  // 等一次往返再關掉表單反而比較篤定（存不起來時表單還在，內容不會白打）。
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const invalidateLeaves = () =>
    qc.invalidateQueries({ queryKey: ['leaves', workspaceId] })
  const failure = (e: unknown, fallback: string) =>
    setLeaveError(e instanceof ApiError
      ? [e.title, e.detail].filter(Boolean).join('：')
      : fallback)

  const saveLeave = useMutation({
    mutationFn: (f: LeaveForm) => f.id
      // 改的時候不送 userId —— 換人請假等於換一筆，後端也不收
      ? Api.patchLeave(f.id, {
          leaveType: f.leaveType,
          startDate: f.startDate,
          endDate: f.endDate,
          note: f.note.trim() || null,
        })
      : Api.createLeave(workspaceId, {
          userId: f.userId || undefined,
          leaveType: f.leaveType,
          startDate: f.startDate,
          endDate: f.endDate,
          note: f.note.trim() || null,
        }),
    onSuccess: () => { setLeaveForm(null); setLeaveError(null); invalidateLeaves() },
    onError: e => failure(e, C.leave.saveFailed),
  })

  const removeLeave = useMutation({
    mutationFn: (id: string) => Api.deleteLeave(id),
    onSuccess: () => { setLeaveForm(null); setLeaveError(null); invalidateLeaves() },
    onError: e => failure(e, C.leave.deleteFailed),
  })

  const sensors = useSensors(
    // 沒有這個距離門檻的話，單純點一下也會被當成拖曳，開任務就開不起來
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  function onDragStart(e: DragStartEvent) {
    setDragging((e.active.data.current as { piece?: Piece })?.piece ?? null)
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    const overId = e.over?.id
    if (typeof overId !== 'string' || !overId.startsWith('day:')) return
    const day = overId.slice(4)
    const piece = (e.active.data.current as { piece?: Piece })?.piece
    if (!piece) return

    // 請假根本不掛拖曳，這裡再擋一次是為了萬一日後有人給它加上 draggable ——
    // 改假一定要走表單，拖著平移會把假別與備註留在原地、日期卻變了
    if (piece.kind === 'leave') return

    if (piece.kind === 'inquiry') {
      if (piece.day !== day) moveInquiry.mutate({ id: piece.inquiryId, dueDate: day })
      return
    }
    if (piece.start === day) return
    reschedule.mutate({
      id: piece.taskId,
      startDate: day,
      dueDate: shiftYmd(day, piece.days - 1),   // 拖曳只平移，不改長度
    })
  }

  const go = (n: number) =>
    setCursor(c => {
      const d = new Date(c.year, c.month + n, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })

  const taskCount = visiblePieces.filter(p => p.kind === 'task').length
  const inqCount = visiblePieces.filter(p => p.kind === 'inquiry').length
  const leaveCount = visiblePieces.filter(p => p.kind === 'leave').length

  /** 登記新的一筆：預設今天、事假、填自己的 */
  const openNewLeave = () => {
    setLeaveError(null)
    setLeaveForm({
      id: null, userId: '', userName: '',
      leaveType: 'PERSONAL', startDate: today, endDate: today, note: '',
    })
  }
  /** 點長條進來改。只有 canEdit 的那幾筆會走到這裡 */
  const openLeave = (l: Leave) => {
    setLeaveError(null)
    setLeaveForm({
      id: l.id, userId: l.userId, userName: l.userName,
      leaveType: l.leaveType, startDate: l.startDate, endDate: l.endDate,
      note: l.note ?? '',
    })
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex h-full flex-col">

        {/* ── 工具列 ── */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2
                        dark:border-slate-700 dark:bg-slate-900">
          <Button variant="ghost" onClick={() => go(-1)} aria-label={C.prevMonth}>‹</Button>
          <div className="min-w-[7.5rem] text-center text-sm font-semibold text-slate-800
                          dark:text-slate-100">
            {monthLabel(cursor.year, cursor.month)}
          </div>
          <Button variant="ghost" onClick={() => go(1)} aria-label={C.nextMonth}>›</Button>
          <Button
            onClick={() => {
              const d = new Date()
              setCursor({ year: d.getFullYear(), month: d.getMonth() })
            }}
          >{C.today}</Button>

          <div className="ml-3 flex items-center gap-3 text-sm">
            <label className="flex cursor-pointer items-center gap-1.5 text-slate-600
                              dark:text-slate-300">
              <input type="checkbox" checked={showTasks}
                     onChange={e => setShowTasks(e.target.checked)}
                     className="rounded border-slate-300 dark:border-slate-600 dark:bg-slate-800" />
              {C.filterTasks} <span className="text-xs text-slate-400 dark:text-slate-400">{taskCount}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-slate-600
                              dark:text-slate-300">
              <input type="checkbox" checked={showInquiries}
                     onChange={e => setShowInquiries(e.target.checked)}
                     className="rounded border-slate-300 dark:border-slate-600 dark:bg-slate-800" />
              {C.filterInquiries} <span className="text-xs text-slate-400 dark:text-slate-400">{inqCount}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-slate-600
                              dark:text-slate-300">
              <input type="checkbox" checked={showLeaves}
                     onChange={e => setShowLeaves(e.target.checked)}
                     className="rounded border-slate-300 dark:border-slate-600 dark:bg-slate-800" />
              {C.filterLeaves} <span className="text-xs text-slate-400 dark:text-slate-400">{leaveCount}</span>
            </label>
          </div>

          <Button onClick={openNewLeave}>{C.leave.add}</Button>

          <span className="ml-auto text-xs text-slate-400 dark:text-slate-400">{C.dragHint}</span>
        </div>

        {/* 請假讀不到時講一聲 —— 不然畫面上「沒有人請假」跟「沒讀到」長得一樣 */}
        {leaveFailed && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700
                          dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {C.leave.loadFailed}
          </div>
        )}

        {/* ── 未排期任務 ── */}
        {undated.length > 0 && (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/60 px-4 py-2
                          dark:border-amber-500/30 dark:bg-amber-500/10">
            <span className="mt-0.5 shrink-0 text-xs font-medium text-amber-800 dark:text-amber-300">
              {C.undated(undated.length)}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {undated.slice(0, 12).map(t => (
                <UndatedChip key={t.id} task={t} />
              ))}
              {undated.length > 12 && (
                <span className="self-center text-xs text-amber-700 dark:text-amber-400">
                  {C.undatedMore(undated.length - 12)}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── 星期列 ── */}
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50
                        dark:border-slate-700 dark:bg-slate-900">
          {WEEKDAY_LABELS.map((w, i) => (
            <div key={w}
                 className={cx(
                   'py-1.5 text-center text-xs font-medium',
                   i === 0 || i === 6
                     ? 'text-slate-400 dark:text-slate-400'
                     : 'text-slate-500 dark:text-slate-400'
                 )}>
              {w}
            </div>
          ))}
        </div>

        {/* ── 月格 ── */}
        <div className="min-h-0 flex-1 overflow-auto">
          {weeks.map((week, w) => (
            <div key={w} className="relative border-b border-slate-200 last:border-b-0 dark:border-slate-700"
                 style={{ minHeight: DATE_ROW_H + week.laneCount * LANE_H + 10 }}>
              {/* 底層：七個日格，負責邊框、日期數字與放置目標 */}
              <div className="grid h-full grid-cols-7">
                {week.days.map((d, i) => (
                  <DayCell
                    key={d}
                    day={d}
                    isToday={d === today}
                    inMonth={parseYmd(d).getMonth() === cursor.month}
                    isWeekend={i === 0 || i === 6}
                    hidden={week.hiddenPerDay[i]}
                  />
                ))}
              </div>
              {/* 上層：跨日長條 */}
              <div className="pointer-events-none absolute inset-x-0"
                   style={{ top: DATE_ROW_H }}>
                {week.segments.map(seg => seg.piece.kind === 'leave' ? (
                  <LeaveBar
                    key={`${seg.piece.key}:${w}`}
                    seg={seg}
                    leave={seg.piece.leave}
                    onEdit={openLeave}
                  />
                ) : (
                  <SegmentBar
                    key={`${seg.piece.key}:${w}`}
                    seg={seg}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {visiblePieces.length === 0 && (
          <Empty>{C.empty}</Empty>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {/* 請假不會被拖起來，所以這裡只有兩種 */}
        {dragging && dragging.kind !== 'leave' && (
          <div className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-white shadow-lg
                          dark:bg-slate-700">
            {dragging.kind === 'task'
              ? C.dragTask(dragging.title, dragging.days)
              : C.dragInquiry(dragging.unit, dragging.title)}
          </div>
        )}
      </DragOverlay>

      {leaveForm && (
        <LeaveDialog
          form={leaveForm}
          workspaceId={workspaceId}
          canManage={canManageLeaves}
          meId={me?.id ?? ''}
          error={leaveError}
          busy={saveLeave.isPending || removeLeave.isPending}
          onChange={setLeaveForm}
          onError={setLeaveError}
          onClose={() => { setLeaveForm(null); setLeaveError(null) }}
          onSave={f => saveLeave.mutate(f)}
          onDelete={id => removeLeave.mutate(id)}
        />
      )}
    </DndContext>
  )
}

// ── 日格（放置目標）─────────────────────────────────────
function DayCell({
  day, isToday, inMonth, isWeekend, hidden,
}: {
  day: string
  isToday: boolean
  inMonth: boolean
  isWeekend: boolean
  hidden: number
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` })
  const n = parseYmd(day).getDate()
  return (
    <div
      ref={setNodeRef}
      className={cx(
        'relative border-r border-slate-100 last:border-r-0 transition-colors',
        'dark:border-slate-800',
        // 不在當月、假日都是「往下壓一階」，深色下要壓得比卡片更暗才看得出來
        !inMonth && 'bg-slate-50/60 dark:bg-slate-950/60',
        isWeekend && inMonth && 'bg-slate-50/30 dark:bg-slate-950/30',
        isOver && 'bg-blue-50 ring-1 ring-inset ring-blue-400 dark:bg-blue-500/15'
      )}
    >
      <div className="flex items-center justify-between px-1.5 pt-1"
           style={{ height: DATE_ROW_H }}>
        <span className={cx(
          'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs',
          isToday ? 'bg-blue-600 font-semibold text-white dark:bg-blue-500'
                  : inMonth ? 'text-slate-600 dark:text-slate-300'
                            : 'text-slate-300 dark:text-slate-500'
        )}>{n}</span>
        {hidden > 0 && (
          <span className="text-[10px] text-slate-400 dark:text-slate-400">
            {C.hiddenCount(hidden)}
          </span>
        )}
      </div>
    </div>
  )
}

/** 長條在這一週列裡的位置。左右各縮 3px，相鄰兩條之間才看得出縫 */
function barStyle({ startCol, endCol, lane }: Segment): React.CSSProperties {
  return {
    left: `calc(${(startCol / 7) * 100}% + 3px)`,
    width: `calc(${((endCol - startCol + 1) / 7) * 100}% - 6px)`,
    top: lane * LANE_H,
    height: LANE_H - 3,
  }
}

// ── 跨日長條 / 期望回覆日標記 ───────────────────────────
function SegmentBar({ seg, onOpen }: { seg: Segment; onOpen: (id: string) => void }) {
  const { piece, startCol } = seg
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `${piece.key}:${startCol}`,
    data: { piece },
  })

  const style = barStyle(seg)

  if (piece.kind === 'leave') return null   // 請假走 LeaveBar，那一條不能拖

  if (piece.kind === 'inquiry') {
    const cls = piece.status === 'OVERDUE'
      ? 'bg-red-100 text-red-800 ring-red-300 '
        + 'dark:bg-red-500/20 dark:text-red-200 dark:ring-red-400/40'
      : piece.status === 'REPLIED'
        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 '
          + 'dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30'
        : 'bg-amber-50 text-amber-800 ring-amber-200 '
          + 'dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30'
    return (
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        onClick={() => onOpen(piece.taskId)}
        title={C.inquiryTooltip(piece.unit, piece.title, shortDate(piece.day))}
        style={style}
        className={cx(
          'pointer-events-auto absolute flex cursor-grab items-center gap-1 overflow-hidden',
          'rounded px-1.5 text-[11px] font-medium ring-1 ring-inset active:cursor-grabbing',
          cls, isDragging && 'opacity-40'
        )}
      >
        <span aria-hidden>{piece.status === 'OVERDUE' ? '⚠️' : '✉'}</span>
        <span className="truncate">{piece.unit}</span>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(piece.taskId)}
      title={C.taskTooltip(piece.ref, piece.title,
                           shortDate(piece.start), shortDate(piece.end), piece.days)}
      style={{ ...style, backgroundColor: piece.color }}
      className={cx(
        'pointer-events-auto absolute flex cursor-grab items-center gap-1 overflow-hidden',
        'rounded px-1.5 text-[11px] font-medium shadow-sm active:cursor-grabbing',
        // 長條的底色是狀態色（使用者自己挑的），淺色狀態配白字只有 2.5:1
        textOnColor(piece.color),
        piece.overdue && 'ring-2 ring-inset ring-red-500',
        isDragging && 'opacity-40'
      )}
    >
      {piece.inquiryState === 'OVERDUE' && <span aria-hidden>⚠️</span>}
      <span className="truncate">{piece.title}</span>
    </div>
  )
}

// ── 請假的跨日長條 ──────────────────────────────────────
/**
 * 刻意不掛 useDraggable —— 請假不能用拖的改期（理由見 Piece 上的註解）。
 * 能改的那幾筆點下去開表單；不能改的就只是一條「這幾天他不在」的資訊。
 *
 * 顏色固定用紫色系（不分假別）：假別已經寫在長條上了，再各給一個顏色，
 * 就會跟任務狀態的顏色搶著被解讀。
 */
function LeaveBar({ seg, leave, onEdit }: {
  seg: Segment
  leave: Leave
  onEdit: (l: Leave) => void
}) {
  const typeLabel = C.leave.types[leave.leaveType]
  const base = C.leave.tooltip(
    leave.userName, typeLabel,
    shortDate(leave.startDate), shortDate(leave.endDate), leave.days
  )
  // 備註只有本人與管理者拿得到，拿不到的人這裡本來就是 null
  const title = leave.note
    ? C.leave.tooltipWithNote(base, leave.note)
    : leave.canEdit ? base : C.leave.tooltipReadOnly(base)

  return (
    <div
      style={barStyle(seg)}
      onClick={leave.canEdit ? () => onEdit(leave) : undefined}
      title={title}
      className={cx(
        'pointer-events-auto absolute flex items-center overflow-hidden',
        'rounded px-1.5 text-[11px] font-medium ring-1 ring-inset',
        'bg-violet-50 text-violet-700 ring-violet-200',
        'dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/30',
        leave.canEdit
          ? 'cursor-pointer hover:bg-violet-100 dark:hover:bg-violet-500/25'
          : 'cursor-default'
      )}
    >
      <span className="truncate">{C.leave.bar(leave.userName, typeLabel)}</span>
    </div>
  )
}

// ── 登記／修改請假的表單 ────────────────────────────────
/**
 * 起訖日一律用原生的日期輸入，值本身就是 YYYY-MM-DD 字串 ——
 * 中間不轉成 Date 再轉回來，那是整份程式碼裡最容易位移一天的地方。
 */
function LeaveDialog({
  form, workspaceId, canManage, meId, error, busy,
  onChange, onError, onClose, onSave, onDelete,
}: {
  form: LeaveForm
  workspaceId: string
  canManage: boolean
  meId: string
  error: string | null
  busy: boolean
  onChange: (f: LeaveForm) => void
  onError: (msg: string) => void
  onClose: () => void
  onSave: (f: LeaveForm) => void
  onDelete: (id: string) => void
}) {
  const editing = form.id !== null

  // 幫別人登記是管理者的權力。改既有那筆時不列人 —— 換人請假等於換一筆
  const { data: userData } = useQuery({
    queryKey: ['workspace-users', workspaceId],
    queryFn: () => Api.workspaceUsers(workspaceId),
    enabled: canManage && !editing && !!workspaceId,
  })
  const others = (userData?.users ?? []).filter(u => u.id !== meId)

  const ok = !!form.startDate && !!form.endDate && form.startDate <= form.endDate
  const days = ok
    ? diffDays(parseYmd(form.startDate), parseYmd(form.endDate)) + 1
    : 0

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // 前端先擋一次是為了當場給回饋；後端與資料表各自還會再擋一次
    if (!form.startDate || !form.endDate) { onError(C.leave.errorRequired); return }
    if (form.startDate > form.endDate) { onError(C.leave.errorRange); return }
    onSave(form)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/20 p-4
                    dark:bg-slate-950/60"
         onClick={onClose}>
      {/* 疊在卡片上的浮層，深色底要比卡片再亮一階才分得出層次 */}
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl dark:bg-slate-800"
      >
        <h2 className="mb-4 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {editing ? C.leave.editTitle : C.leave.addTitle}
        </h2>

        <div className="space-y-3">
          <Field label={C.leave.fieldUser}>
            {editing ? (
              // 改的時候人是固定的，只把是誰寫出來
              <div className="px-0.5 py-1.5 text-sm text-slate-800 dark:text-slate-100">
                {form.userName}
              </div>
            ) : canManage && others.length > 0 ? (
              <>
                <Select
                  className="w-full"
                  value={form.userId}
                  onChange={e => onChange({ ...form, userId: e.target.value })}
                >
                  <option value="">{C.leave.selfOption}</option>
                  {others.map(u => (
                    <option key={u.id} value={u.id}>{u.displayName}</option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-400">
                  {C.leave.userHint}
                </p>
              </>
            ) : (
              <div className="px-0.5 py-1.5 text-sm text-slate-800 dark:text-slate-100">
                {C.leave.selfOption}
              </div>
            )}
          </Field>

          <Field label={C.leave.fieldType}>
            <Select
              className="w-full"
              value={form.leaveType}
              onChange={e => onChange({ ...form, leaveType: e.target.value as LeaveType })}
            >
              {LEAVE_TYPE_KEYS.map(k => (
                <option key={k} value={k}>{C.leave.types[k]}</option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={C.leave.fieldStart}>
              <Input
                type="date"
                value={form.startDate}
                onChange={e => onChange({ ...form, startDate: e.target.value })}
              />
            </Field>
            <Field label={C.leave.fieldEnd}>
              <Input
                type="date"
                value={form.endDate}
                onChange={e => onChange({ ...form, endDate: e.target.value })}
              />
            </Field>
          </div>

          {ok && (
            <p className="text-xs text-slate-500 dark:text-slate-400">{C.leave.dayCount(days)}</p>
          )}

          <Field label={C.leave.fieldNote}>
            <Input
              value={form.note}
              maxLength={500}
              placeholder={C.leave.notePlaceholder}
              onChange={e => onChange({ ...form, note: e.target.value })}
            />
          </Field>
        </div>

        {error && (
          <p className="mt-3 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700
                        dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          {editing && (
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => {
                const ask = C.leave.deleteConfirm(
                  form.userName, shortDate(form.startDate), shortDate(form.endDate))
                if (form.id && window.confirm(ask)) onDelete(form.id)
              }}
            >{T.common.delete}</Button>
          )}
          <Button type="button" variant="ghost" className="ml-auto"
                  disabled={busy} onClick={onClose}>
            {T.common.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {T.common.save}
          </Button>
        </div>
      </form>
    </div>
  )
}

// ── 未排期任務（可以拖進月格）───────────────────────────
function UndatedChip({ task }: { task: Task }) {
  const piece: Piece = {
    kind: 'task',
    key: `task:${task.id}`,
    taskId: task.id,
    title: task.title,
    ref: task.ref,
    start: '',
    end: '',
    days: 1,
    color: '#64748b',
    overdue: false,
    inquiryState: task.inquiryState,
  }
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `undated:${task.id}`,
    data: { piece },
  })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      title={C.undatedTooltip(task.ref, task.title)}
      className={cx(
        'cursor-grab rounded border border-amber-300 bg-white px-1.5 py-0.5',
        'text-[11px] text-slate-700 active:cursor-grabbing',
        'dark:border-amber-500/40 dark:bg-slate-900 dark:text-slate-200',
        isDragging && 'opacity-40'
      )}
    >
      {task.title}
    </div>
  )
}
