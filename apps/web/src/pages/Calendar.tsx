import { useMemo, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Inquiry, type InquiryState, type Task, type TaskStatus } from '../lib/api'
import { Button, Empty, cx } from '../components/ui'
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

type Segment = { piece: Piece; startCol: number; endCol: number; lane: number }

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
  const today = todayYmd()
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const [showTasks, setShowTasks] = useState(true)
  const [showInquiries, setShowInquiries] = useState(true)
  const [dragging, setDragging] = useState<Piece | null>(null)

  // 發文追蹤是工作區層級的端點，這裡只取這個專案的
  const { data: board } = useQuery({
    queryKey: ['inquiry-board', workspaceId],
    queryFn: () => Api.inquiryBoard(workspaceId),
    enabled: !!workspaceId,
  })
  const inquiries = useMemo(
    () => (board?.inquiries ?? []).filter(i => i.projectId === projectId),
    [board, projectId]
  )

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
    return { pieces: out, undated: none }
  }, [tasks, inquiries, statusColor, doneKeys, today])

  const visiblePieces = useMemo(
    () => pieces.filter(p => (p.kind === 'task' ? showTasks : showInquiries)),
    [pieces, showTasks, showInquiries]
  )

  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])
  const gridYmd = useMemo(() => grid.map(ymd), [grid])

  // ── 每週各自做 lane packing ───────────────────────────
  const weeks = useMemo(() => {
    return Array.from({ length: 6 }, (_, w) => {
      const days = gridYmd.slice(w * 7, w * 7 + 7)
      const from = days[0]
      const to = days[6]

      const raw = visiblePieces
        .map(p => {
          const s = p.kind === 'task' ? p.start : p.day
          const e = p.kind === 'task' ? p.end : p.day
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

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex h-full flex-col">

        {/* ── 工具列 ── */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
          <Button variant="ghost" onClick={() => go(-1)} aria-label="上個月">‹</Button>
          <div className="min-w-[7.5rem] text-center text-sm font-semibold text-slate-800">
            {monthLabel(cursor.year, cursor.month)}
          </div>
          <Button variant="ghost" onClick={() => go(1)} aria-label="下個月">›</Button>
          <Button
            onClick={() => {
              const d = new Date()
              setCursor({ year: d.getFullYear(), month: d.getMonth() })
            }}
          >今天</Button>

          <div className="ml-3 flex items-center gap-3 text-sm">
            <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
              <input type="checkbox" checked={showTasks}
                     onChange={e => setShowTasks(e.target.checked)}
                     className="rounded border-slate-300" />
              任務 <span className="text-xs text-slate-400">{taskCount}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
              <input type="checkbox" checked={showInquiries}
                     onChange={e => setShowInquiries(e.target.checked)}
                     className="rounded border-slate-300" />
              期望回覆日 <span className="text-xs text-slate-400">{inqCount}</span>
            </label>
          </div>

          <span className="ml-auto text-xs text-slate-400">
            拖到哪一天，就從那天開始（長度不變）
          </span>
        </div>

        {/* ── 未排期任務 ── */}
        {undated.length > 0 && (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/60 px-4 py-2">
            <span className="mt-0.5 shrink-0 text-xs font-medium text-amber-800">
              未排期 {undated.length}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {undated.slice(0, 12).map(t => (
                <UndatedChip key={t.id} task={t} />
              ))}
              {undated.length > 12 && (
                <span className="self-center text-xs text-amber-700">
                  還有 {undated.length - 12} 張
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── 星期列 ── */}
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {WEEKDAY_LABELS.map((w, i) => (
            <div key={w}
                 className={cx(
                   'py-1.5 text-center text-xs font-medium',
                   i === 0 || i === 6 ? 'text-slate-400' : 'text-slate-500'
                 )}>
              {w}
            </div>
          ))}
        </div>

        {/* ── 月格 ── */}
        <div className="min-h-0 flex-1 overflow-auto">
          {weeks.map((week, w) => (
            <div key={w} className="relative border-b border-slate-200 last:border-b-0"
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
                {week.segments.map(seg => (
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
          <Empty>這個工作區還沒有帶日期的任務。到清單或看板設定開始日與到期日，就會出現在這裡。</Empty>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-white shadow-lg">
            {dragging.kind === 'task'
              ? `${dragging.title}（${dragging.days} 天）`
              : `${dragging.unit}：${dragging.title}`}
          </div>
        )}
      </DragOverlay>
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
        !inMonth && 'bg-slate-50/60',
        isWeekend && inMonth && 'bg-slate-50/30',
        isOver && 'bg-blue-50 ring-1 ring-inset ring-blue-400'
      )}
    >
      <div className="flex items-center justify-between px-1.5 pt-1"
           style={{ height: DATE_ROW_H }}>
        <span className={cx(
          'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs',
          isToday ? 'bg-blue-600 font-semibold text-white'
                  : inMonth ? 'text-slate-600' : 'text-slate-300'
        )}>{n}</span>
        {hidden > 0 && (
          <span className="text-[10px] text-slate-400">還有 {hidden} 筆</span>
        )}
      </div>
    </div>
  )
}

// ── 跨日長條 / 期望回覆日標記 ───────────────────────────
function SegmentBar({ seg, onOpen }: { seg: Segment; onOpen: (id: string) => void }) {
  const { piece, startCol, endCol, lane } = seg
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `${piece.key}:${startCol}`,
    data: { piece },
  })

  const style: React.CSSProperties = {
    left: `calc(${(startCol / 7) * 100}% + 3px)`,
    width: `calc(${((endCol - startCol + 1) / 7) * 100}% - 6px)`,
    top: lane * LANE_H,
    height: LANE_H - 3,
  }

  if (piece.kind === 'inquiry') {
    const cls = piece.status === 'OVERDUE'
      ? 'bg-red-100 text-red-800 ring-red-300'
      : piece.status === 'REPLIED'
        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
        : 'bg-amber-50 text-amber-800 ring-amber-200'
    return (
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        onClick={() => onOpen(piece.taskId)}
        title={`${piece.unit}｜${piece.title}｜期望 ${shortDate(piece.day)} 前回覆`}
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
      title={`${piece.ref} ${piece.title}｜${shortDate(piece.start)} – ${shortDate(piece.end)}（${piece.days} 天）`}
      style={{ ...style, backgroundColor: piece.color }}
      className={cx(
        'pointer-events-auto absolute flex cursor-grab items-center gap-1 overflow-hidden',
        'rounded px-1.5 text-[11px] font-medium text-white shadow-sm active:cursor-grabbing',
        piece.overdue && 'ring-2 ring-inset ring-red-500',
        isDragging && 'opacity-40'
      )}
    >
      {piece.inquiryState === 'OVERDUE' && <span aria-hidden>⚠️</span>}
      <span className="truncate">{piece.title}</span>
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
      title={`${task.ref} ${task.title}｜拖到日期上就會排期`}
      className={cx(
        'cursor-grab rounded border border-amber-300 bg-white px-1.5 py-0.5',
        'text-[11px] text-slate-700 active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
    >
      {task.title}
    </div>
  )
}
