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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Api, type Task, type TaskStatus } from '../lib/api'
import { InquiryBadge, ProblemBadge, cx } from '../components/ui'
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
          <Column key={col.key} column={col} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay>
        {dragging && <Card task={dragging} overlay onOpen={() => {}} />}
      </DragOverlay>
    </DndContext>
  )
}

function Column({
  column, onOpen,
}: {
  column: TaskStatus & { tasks: Task[] }
  onOpen: (id: string) => void
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
          {column.tasks.map(t => <SortableCard key={t.id} task={t} onOpen={onOpen} />)}
          {column.tasks.length === 0 && (
            <div className="rounded-md border-2 border-dashed border-slate-200 py-6 text-center text-xs
                            text-slate-400 dark:border-slate-700 dark:text-slate-500">
              {T.task.board.dropHere}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

function SortableCard({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id })
  return (
    <div ref={setNodeRef} {...attributes} {...listeners}
         style={{ transform: CSS.Transform.toString(transform), transition }}
         className={isDragging ? 'opacity-30' : ''}>
      <Card task={task} onOpen={onOpen} />
    </div>
  )
}

function Card({
  task, onOpen, overlay,
}: {
  task: Task; onOpen: (id: string) => void; overlay?: boolean
}) {
  return (
    <div
      onClick={() => onOpen(task.id)}
      className={cx(
        'cursor-grab rounded-lg bg-white p-2.5 ring-1 ring-slate-200 active:cursor-grabbing',
        'dark:bg-slate-900 dark:ring-slate-700',
        overlay ? 'rotate-2 shadow-xl' : 'hover:ring-slate-300 dark:hover:ring-slate-600'
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{task.ref}</span>
        {task.type === 'MILESTONE' && <span className="text-[11px]">◆</span>}
        {task.priority === 'URGENT' && (
          <span className="rounded bg-red-100 px-1 text-[10px] font-medium text-red-700
                           dark:bg-red-500/15 dark:text-red-300">
            {T.task.priority.URGENT}
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

      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
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
