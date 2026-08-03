import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Api, type Project, type Task } from '../lib/api'
import { rollup } from '../lib/rollup'
import { Button, Input, cx } from './ui'

/**
 * 側欄＝這個專案的結構樹，右邊是內容——主從式（master-detail）版面。
 *
 *   點大項目 → 右邊回到總覽（清單/看板/甘特），只顯示那一塊
 *   點小項目 → 右邊直接顯示那張任務的詳情
 *
 * 選中的節點會highlight，所以「左邊選什麼、右邊就是什麼」一眼看得出來，
 * 不會像浮動抽屜那樣蓋住畫面、關掉之後又不知道剛剛看的是哪一張。
 *
 * 大項目 = parentId 為 null 的任務，就是既有的 parent_id 階層，沒有另開表。
 */
export function EpicSidebar({
  project, tasks, selectedEpicId, onSelectEpic, selectedTaskId, onOpenTask,
  onSwitchProject, onInquiryBoard, inquiryActive, overdueTotal,
  userName, onLogout, onAccount, bell,
}: {
  project?: Project
  tasks: Task[]
  /** null = 全部任務（不篩選） */
  selectedEpicId: string | null
  onSelectEpic: (id: string | null) => void
  /** 目前在右邊顯示詳情的任務 */
  selectedTaskId: string | null
  /** 點小項目 → 在右邊顯示那張任務 */
  onOpenTask: (id: string) => void
  onSwitchProject: () => void
  onInquiryBoard: () => void
  inquiryActive: boolean
  overdueTotal: number
  userName: string
  onLogout: () => void
  onAccount: () => void
  /** 通知鈴鐺。放在最底下那排，因為專案裡的每個畫面都看得到側欄 */
  bell?: ReactNode
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { epics, stat, looseCount, childrenOf } = useMemo(() => {
    const ids = new Set(tasks.map(t => t.id))
    const epics = tasks.filter(t => !t.parentId)
    const rolled = rollup(tasks)

    // 子樹裡有沒有「單位逾期未回」——要走完整棵子樹，不能只看直屬子任務
    const kids = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.parentId || !ids.has(t.parentId)) continue
      const a = kids.get(t.parentId) ?? []; a.push(t); kids.set(t.parentId, a)
    }
    const overdueIn = (rootId: string): number => {
      let n = 0
      const walk = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return
        seen.add(id)
        const self = tasks.find(t => t.id === id)
        if (self?.inquiryState === 'OVERDUE') n++
        for (const k of kids.get(id) ?? []) walk(k.id, seen)
      }
      walk(rootId)
      return n
    }

    const stat = new Map(epics.map(e => {
      const r = rolled.get(e.id)
      return [e.id, {
        progress: r?.progress ?? e.progress,
        // 葉節點的 totalCount 是 1（自己），對大項目沒有意義，一律以子任務數為準
        done: r?.derived ? r.doneCount : (e.progress >= 100 ? 1 : 0),
        total: r?.derived ? r.totalCount : 1,
        hasChildren: !!r?.derived,
        overdue: overdueIn(e.id),
      }]
    }))

    const looseCount = tasks.filter(t => t.parentId && !ids.has(t.parentId)).length
    return { epics, stat, looseCount, childrenOf: kids }
  }, [tasks])

  // 右邊正在看的任務，它所屬的大項目自動展開，不然使用者會找不到自己在哪
  const autoOpen = useMemo(() => {
    if (!selectedTaskId) return null
    let cur = tasks.find(t => t.id === selectedTaskId)
    const guard = new Set<string>()
    while (cur?.parentId && !guard.has(cur.id)) {
      guard.add(cur.id)
      const parent = tasks.find(t => t.id === cur!.parentId)
      if (!parent) break
      cur = parent
    }
    return cur?.id ?? null
  }, [selectedTaskId, tasks])

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const create = useMutation({
    mutationFn: (t: string) => Api.createTask(project!.id, { title: t, type: 'EPIC' }),
    onSuccess: () => {
      setTitle(''); setAdding(false)
      qc.invalidateQueries({ queryKey: ['tasks', project!.id] })
    },
  })

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">

      {/* ── 專案標頭：切換專案的入口在這裡 ── */}
      <div className="border-b border-slate-200 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: project?.color ?? '#94a3b8' }} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
            {project?.name ?? '—'}
          </span>
        </div>
        <button onClick={onSwitchProject}
                className="mt-1.5 text-xs text-slate-400 hover:text-slate-600">
          ⇄ 切換專案
        </button>
      </div>

      <button onClick={onInquiryBoard}
              className={cx(
                'mx-2 mt-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm',
                inquiryActive
                  ? 'bg-blue-50 font-medium text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50'
              )}>
        <span>📮</span> 發文追蹤
        {overdueTotal > 0 && (
          <span className="ml-auto rounded bg-red-100 px-1.5 text-xs font-medium text-red-700">
            {overdueTotal}
          </span>
        )}
      </button>

      <div className="px-4 pb-1 pt-3">
        <div className="text-xs font-medium tracking-wide text-slate-400">大項目</div>
        <div className="mt-0.5 text-[11px] leading-snug text-slate-400">
          點大項目看總覽，點小項目在右邊開詳情
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button
          onClick={() => onSelectEpic(null)}
          className={cx(
            'mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm',
            !inquiryActive && selectedEpicId === null
              ? 'bg-slate-100 font-medium text-slate-800'
              : 'text-slate-600 hover:bg-slate-50'
          )}>
          <span className="text-slate-400">☰</span>
          <span className="flex-1">全部任務</span>
          <span className="text-xs tabular-nums text-slate-400">{tasks.length}</span>
        </button>

        {epics.length === 0 && (
          <div className="px-2.5 py-3 text-xs leading-relaxed text-slate-400">
            還沒有大項目。<br />
            大項目就是把一件大事分成幾塊，例如「機房搬遷」底下掛盤點、採購、搬運。
          </div>
        )}

        {epics.map(epic => {
          const s = stat.get(epic.id)!
          const active = !inquiryActive && selectedEpicId === epic.id && !selectedTaskId
          const kids = childrenOf.get(epic.id) ?? []
          const open = expanded.has(epic.id) || autoOpen === epic.id
          return (
            <div key={epic.id} className="mb-0.5">
            <div className={cx('flex items-start rounded-md',
              active ? 'bg-slate-100' : 'hover:bg-slate-50')}>
            <button
              onClick={e => { e.stopPropagation(); toggle(epic.id) }}
              disabled={!kids.length}
              aria-label={open ? '收合' : '展開'}
              aria-expanded={open}
              className={cx('w-6 shrink-0 py-2.5 text-xs',
                kids.length ? 'text-slate-400 hover:text-slate-700' : 'text-transparent')}>
              {open ? '▾' : '▸'}
            </button>
            <button
              onClick={() => onSelectEpic(epic.id)}
              title={s.hasChildren
                ? `${epic.title}　${s.done}/${s.total} 個小項目已完成`
                : epic.title}
              className="block min-w-0 flex-1 rounded-md py-2 pr-2.5 text-left">
              <div className="flex items-center gap-2">
                <span className={cx(
                  'min-w-0 flex-1 truncate text-sm',
                  active ? 'font-medium text-slate-800' : 'text-slate-700'
                )}>{epic.title}</span>
                {s.overdue > 0 && (
                  <span title={`底下有 ${s.overdue} 張任務的單位逾期未回`}
                        className="shrink-0 rounded bg-red-100 px-1 text-[10px] font-medium text-red-700">
                    {s.overdue}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <span className={cx('block h-full',
                          s.progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                        style={{ width: `${s.progress}%` }} />
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                  {s.progress}%
                </span>
                {s.hasChildren && (
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                    {s.done}/{s.total}
                  </span>
                )}
              </div>
            </button>
            </div>

            {/* 小項目：點了在右邊開詳情，選中的那張會 highlight */}
            {open && kids.map(kid => {
              const on = kid.id === selectedTaskId
              return (
                <button
                  key={kid.id}
                  onClick={() => onOpenTask(kid.id)}
                  title={`${kid.ref}　${kid.title}`}
                  aria-current={on ? 'true' : undefined}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-left text-[13px]',
                    on ? 'bg-blue-50 font-medium text-blue-700'
                       : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                  )}>
                  <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full',
                    kid.progress >= 100 ? 'bg-emerald-500' : 'bg-slate-300')} />
                  <span className="min-w-0 flex-1 truncate">{kid.title}</span>
                  {kid.inquiryState === 'OVERDUE' && (
                    <span title="單位逾期未回" className="shrink-0 text-[11px] text-red-600">⚠️</span>
                  )}
                </button>
              )
            })}
            </div>
          )
        })}

        {looseCount > 0 && (
          <div className="mt-2 px-2.5 text-[11px] leading-snug text-slate-400">
            另有 {looseCount} 個任務的上層已被刪除，在「全部任務」裡找得到
          </div>
        )}

        {adding ? (
          <div className="mt-2 space-y-1.5 rounded-md bg-slate-50 p-2">
            <Input value={title} onChange={e => setTitle(e.target.value)}
                   placeholder="大項目名稱" autoFocus
                   onKeyDown={e => {
                     if (e.key === 'Enter' && title.trim()) create.mutate(title.trim())
                     if (e.key === 'Escape') { setAdding(false); setTitle('') }
                   }} />
            <div className="flex gap-1">
              <Button variant="primary" className="flex-1 justify-center text-xs"
                      disabled={!title.trim() || create.isPending}
                      onClick={() => create.mutate(title.trim())}>建立</Button>
              <Button className="text-xs" onClick={() => { setAdding(false); setTitle('') }}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} disabled={!project}
                  className="mt-1 w-full rounded-md px-2.5 py-2 text-left text-sm text-slate-400
                             hover:bg-slate-50 disabled:opacity-50">
            ＋ 新增大項目
          </button>
        )}
      </nav>

      <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-slate-500">{userName}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            <button onClick={onAccount} className="text-slate-400 hover:text-slate-600">
              帳號設定
            </button>
            <span className="text-slate-200">|</span>
            <button onClick={onLogout} className="text-slate-400 hover:text-slate-600">
              登出
            </button>
          </div>
        </div>
        {bell}
      </div>
    </aside>
  )
}
