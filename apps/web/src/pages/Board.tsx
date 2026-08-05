import { useMemo, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  useSensor, useSensors, closestCorners,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Task, type TaskStatus } from '../lib/api'
import { InquiryBadge, ProblemBadge, cx } from '../components/ui'
import { useAuth } from '../lib/auth'
import { T } from '../strings'

/**
 * 看板：dnd-kit 拖曳。
 *
 * 樂觀更新：放開的瞬間就改本地快取，畫面不等網路。
 * 失敗才回滾 —— 這是所有拖曳互動共用的協定。
 */
export default function Board({
  projectId, tasks, statuses, onOpen,
}: {
  projectId: string
  tasks: Task[]
  statuses: TaskStatus[]
  onOpen: (id: string) => void
}) {
  const qc = useQueryClient()
  const [dragging, setDragging] = useState<Task | null>(null)

  /*
   * 拖一張卡片就是改它的狀態，走的是 POST /tasks/:id/move ——
   * 後端要編輯者以上而且還要是開這張任務的人，專案管理者一律放行。
   * 拖得動卻被退回是最糟的互動，所以拖不了的卡片直接不給拖。
   * queryKey 跟 App 那一層同一組，讀到的是快取。
   */
  const { user } = useAuth()
  const { data: project } = useQuery({
    queryKey: ['project', projectId], queryFn: () => Api.project(projectId),
  })
  /*
   * 我的角色要從成員名單裡撈自己那一列 —— GET /projects/:id 只回成員名單，
   * 沒有「我是什麼角色」這個欄位（回那個欄位的是專案清單 GET /projects）。
   */
  const role = project?.members.find(m => m.id === user?.id)?.role
  // 專案建立者在建立專案時就拿到 MANAGER，所以判斷一律看角色
  const canDrag = (t: Task) =>
    role === 'MANAGER' || (role === 'EDITOR' && !!user && t.createdById === user.id)

  const sensors = useSensors(
    // 要拖 6px 才算開始拖，否則單純點擊會被誤判
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // 鍵盤操作路徑：拖曳功能必須有非滑鼠的替代方式
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const columns = useMemo(() => statuses.map(s => ({
    ...s,
    tasks: tasks.filter(t => t.statusKey === s.key)
                .sort((a, b) => Number(a.rank) - Number(b.rank)),
  })), [statuses, tasks])

  /**
   * 這個專案最急的那一級＝優先度清單排最後的那一個（後端已依 rank 排好）。
   * 清單是空的（舊資料還沒補上）就不標。
   */
  const priorities = project?.priorities ?? []
  const topPriority = priorities.length ? priorities[priorities.length - 1] : undefined

  const move = useMutation({
    mutationFn: ({ id, ...v }: { id: string; statusKey?: string; beforeId?: string | null; afterId?: string | null }) =>
      Api.moveTask(id, v),
    onMutate: async vars => {
      await qc.cancelQueries({ queryKey: ['tasks', projectId] })
      const prev = qc.getQueryData(['tasks', projectId])
      qc.setQueryData(['tasks', projectId], (old: { tasks: Task[] } | undefined) => {
        if (!old) return old
        return {
          tasks: old.tasks.map(t =>
            t.id === vars.id && vars.statusKey ? { ...t, statusKey: vars.statusKey } : t),
        }
      })
      return { prev }
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['tasks', projectId], ctx.prev) },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  })

  function onDragStart(e: DragStartEvent) {
    setDragging(tasks.find(t => t.id === e.active.id) ?? null)
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    const { active, over } = e
    if (!over) return

    const activeTask = tasks.find(t => t.id === active.id)
    if (!activeTask) return
    // 卡片本身已經設成不能拖，這一行是鍵盤與程式路徑的最後一道
    if (!canDrag(activeTask)) return

    // 放在欄的空白處 → over.id 是欄的 key；放在卡片上 → over.id 是卡片 id
    const overColumn = statuses.find(s => s.key === over.id)
    const overTask = tasks.find(t => t.id === over.id)
    const targetStatus = overColumn?.key ?? overTask?.statusKey
    if (!targetStatus) return
    if (targetStatus === activeTask.statusKey && over.id === active.id) return

    const column = columns.find(c => c.key === targetStatus)!
    const list = column.tasks.filter(t => t.id !== active.id)
    const idx = overTask ? list.findIndex(t => t.id === overTask.id) : list.length

    move.mutate({
      id: activeTask.id,
      statusKey: targetStatus,
      afterId: idx > 0 ? list[idx - 1].id : null,
      beforeId: idx < list.length ? list[idx].id : null,
    })
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners}
                onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto p-4">
        {columns.map(col => (
          <Column key={col.key} column={col} onOpen={onOpen} canDrag={canDrag}
                  topPriority={topPriority} />
        ))}
      </div>
      <DragOverlay>
        {dragging && <Card task={dragging} overlay draggable onOpen={() => {}}
                             topPriority={topPriority} />}
      </DragOverlay>
    </DndContext>
  )
}

function Column({
  column, onOpen, canDrag, topPriority,
}: {
  column: TaskStatus & { tasks: Task[] }
  onOpen: (id: string) => void
  topPriority?: { key: string; name: string; color: string }
  /** 這張卡片這個人能不能拖 —— 拖曳等於改狀態，權限跟改任務同一條 */
  canDrag: (t: Task) => boolean
}) {
  const { setNodeRef, isOver } = useSortable({ id: column.key, data: { type: 'column' } })
  const overdue = column.tasks.filter(t => t.inquiryState === 'OVERDUE').length

  return (
    <div ref={setNodeRef}
         className={cx(
           // 欄的底色在深色下要比卡片再暗一階，卡片才浮得起來（淺色是反過來的）
           'flex w-72 shrink-0 flex-col rounded-lg bg-slate-100/80 ring-1 dark:bg-slate-900/50',
           isOver ? 'ring-2 ring-blue-400' : 'ring-slate-200 dark:ring-slate-700'
         )}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="h-2 w-2 rounded-full" style={{ background: column.color }} />
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{column.name}</span>
        <span className="rounded bg-white px-1.5 text-xs text-slate-500
                         dark:bg-slate-800 dark:text-slate-400">{column.tasks.length}</span>
        {overdue > 0 && (
          <span className="ml-auto rounded bg-red-100 px-1.5 text-xs font-medium text-red-700
                           dark:bg-red-500/15 dark:text-red-300">
            {T.task.board.overdueCount(overdue)}
          </span>
        )}
      </div>
      <SortableContext items={column.tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">
          {column.tasks.map(t => (
            <SortableCard key={t.id} task={t} onOpen={onOpen} canDrag={canDrag(t)}
                          topPriority={topPriority} />
          ))}
          {column.tasks.length === 0 && (
            <div className="rounded-md border-2 border-dashed border-slate-200 py-6 text-center text-xs
                            text-slate-400 dark:border-slate-700 dark:text-slate-400">
              {T.task.board.dropHere}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

function SortableCard({ task, onOpen, canDrag, topPriority }: {
  task: Task; onOpen: (id: string) => void; canDrag: boolean
  topPriority?: { key: string; name: string; color: string }
}) {
  // disabled 讓 dnd-kit 連感應器都不掛上去，滑鼠與鍵盤兩條路徑一起擋掉
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id, disabled: !canDrag })
  return (
    <div ref={setNodeRef} {...attributes} {...listeners}
         style={{ transform: CSS.Transform.toString(transform), transition }}
         className={isDragging ? 'opacity-30' : ''}>
      <Card task={task} onOpen={onOpen} draggable={canDrag} topPriority={topPriority} />
    </div>
  )
}

function Card({
  task, onOpen, overlay, draggable, topPriority,
}: {
  task: Task; onOpen: (id: string) => void; overlay?: boolean
  /** 拖不動的卡片不要長成「可以拖」的樣子 —— 手形游標本身就是一種承諾 */
  draggable?: boolean
  /**
   * 這個專案裡最急的那一級（優先度清單的最後一個）。
   * 優先度現在每個專案自己定，不能再認死 'URGENT' 這個 key ——
   * 有人會把它改名叫「火燒屁股」，也有人會刪掉它。卡片上只標最急的那一級，
   * 每一級都標的話等於沒標。
   */
  topPriority?: { key: string; name: string; color: string }
}) {
  return (
    <div
      onClick={() => onOpen(task.id)}
      title={draggable ? undefined : T.task.permission.cannotDragCard}
      className={cx(
        'rounded-lg bg-white p-2.5 ring-1 ring-slate-200',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        'dark:bg-slate-900 dark:ring-slate-700',
        overlay ? 'rotate-2 shadow-xl' : 'hover:ring-slate-300 dark:hover:ring-slate-600'
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-slate-400 dark:text-slate-400">{task.ref}</span>
        {task.type === 'MILESTONE' && <span className="text-[11px]">◆</span>}
        {topPriority && task.priority === topPriority.key && (
          <span className="rounded px-1 text-[10px] font-medium"
                style={{
                  backgroundColor: topPriority.color + '26',   // 15% 透明，淺色深色都吃得下
                  color: topPriority.color,
                }}>
            {topPriority.name}
          </span>
        )}
      </div>
      <div className="text-sm leading-snug text-slate-800 dark:text-slate-200">{task.title}</div>

      {/* 兩種徽章放同一排：卡片本來就窄，各自佔一行會把卡片撐高，
          一欄能看到的卡片數就少了 */}
      {(task.inquiryState !== 'NONE' || task.problem) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <InquiryBadge state={task.inquiryState} />
          <ProblemBadge problem={task.problem} />
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-400">
        {task.dueDate && <span>📅 {task.dueDate.slice(5, 10).replace('-', '/')}</span>}
        {task.assigneeName && <span>👤 {task.assigneeName}</span>}
        {task.progress > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <span className="h-1 w-10 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <span className="block h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
            </span>
            {task.progress}%
          </span>
        )}
      </div>
    </div>
  )
}
