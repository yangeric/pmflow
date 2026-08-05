import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Api, type Project, type Task } from '../lib/api'
import { rollup } from '../lib/rollup'
import { T } from '../strings'
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

/**
 * 收折狀態存在瀏覽器。
 *
 * 「側欄要不要收起來」是看螢幕決定的 —— 在筆電上為了甘特圖寬一點而收起來的人，
 * 換到大螢幕未必想收。存進帳號會讓兩台裝置互相蓋掉，跟深色模式同一個道理。
 */
const COLLAPSE_KEY = 'pmflow.sidebar'

function storedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'collapsed'
  } catch {
    // 隱私模式下 localStorage 會直接丟例外，那就當作沒收起來
    return false
  }
}

function rememberCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? 'collapsed' : 'expanded')
  } catch {
    // 存不進去就只有這次有效，不值得為它中斷操作
  }
}

export function EpicSidebar({
  project, tasks, selectedEpicId, onSelectEpic, selectedTaskId, onOpenTask,
  onSwitchProject,
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
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<boolean>(() => storedCollapsed())

  const { epics, stat, looseCount, childrenOf, bugsUnder } = useMemo(() => {
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

    /**
     * 這個節點**底下**有幾張問題（不含自己）。
     *
     * 收著的大項目顯示整棵子樹的總數，展開之後每張任務再各自顯示自己底下的 ——
     * 所以要走完整棵子樹，不能只看直屬子任務，不然收合前後看到的數字會對不上。
     *
     * 不含自己是刻意的：一張問題自己就掛著「問題」的種類徽章了，
     * 旁邊再標一個「1」只會讓人以為它底下還有東西。
     */
    const bugsUnder = (rootId: string): number => {
      let n = 0
      const walk = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return
        seen.add(id)
        for (const k of kids.get(id) ?? []) {
          if (k.type === 'BUG') n++
          walk(k.id, seen)
        }
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
        bugs: bugsUnder(e.id),
      }]
    }))

    const looseCount = tasks.filter(t => t.parentId && !ids.has(t.parentId)).length
    return { epics, stat, looseCount, childrenOf: kids, bugsUnder }
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

  function setCollapse(v: boolean) {
    setCollapsed(v)
    rememberCollapsed(v)
  }

  const create = useMutation({
    mutationFn: (t: string) => Api.createTask(project!.id, { title: t, type: 'EPIC' }),
    onSuccess: () => {
      setTitle(''); setAdding(false)
      qc.invalidateQueries({ queryKey: ['tasks', project!.id] })
    },
  })

  /**
   * 收起來之後留一條窄條，不是整個消失 ——
   * 整個藏掉的話，「怎麼把它叫回來」就變成一個要學的秘密。
   *
   * 窄條上只剩展開與專案色點：對外詢問已經是上面那排頁籤的一個，
   * 成員搬到右上角的頭像選單，兩個都不再需要側欄的入口。
   */
  if (collapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-slate-200
                        bg-white py-2 dark:border-slate-700 dark:bg-slate-900">
        <button onClick={() => setCollapse(false)}
                title={T.nav.sidebar.expandSidebar}
                aria-label={T.nav.sidebar.expandSidebar}
                className="rounded-md px-2 py-1.5 text-sm text-slate-400 hover:bg-slate-100
                           hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800
                           dark:hover:text-slate-300">
          »
        </button>

        <span className="my-1 h-2.5 w-2.5 shrink-0 rounded-full"
              title={project?.name ?? T.common.none}
              style={{ background: project?.color ?? '#94a3b8' }} />
      </aside>
    )
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white
                      dark:border-slate-700 dark:bg-slate-900">

      {/* ── 專案標頭：切換專案的入口在這裡 ── */}
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: project?.color ?? '#94a3b8' }} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800
                           dark:text-slate-100">
            {project?.name ?? T.common.none}
          </span>
          <button onClick={() => setCollapse(true)}
                  title={T.nav.sidebar.collapseSidebar}
                  aria-label={T.nav.sidebar.collapseSidebar}
                  className="shrink-0 rounded px-1 text-sm text-slate-400 hover:text-slate-700
                             dark:text-slate-400 dark:hover:text-slate-300">
            «
          </button>
        </div>
        <button onClick={onSwitchProject}
                className="mt-1.5 text-xs text-slate-400 hover:text-slate-600
                           dark:text-slate-400 dark:hover:text-slate-300">
          ⇄ {T.nav.sidebar.switchProject}
        </button>
      </div>

      <div className="px-4 pb-1 pt-3">
        <div className="text-xs font-medium tracking-wide text-slate-400 dark:text-slate-400">
          {T.nav.sidebar.epics}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-slate-400 dark:text-slate-400">
          {T.nav.sidebar.epicsHint}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button
          onClick={() => onSelectEpic(null)}
          className={cx(
            'mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm',
            selectedEpicId === null
              ? 'bg-slate-100 font-medium text-slate-800 dark:bg-slate-800 dark:text-slate-100'
              : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
          )}>
          <span className="text-slate-400 dark:text-slate-400">☰</span>
          <span className="flex-1">{T.nav.sidebar.allTasks}</span>
          <span className="text-xs tabular-nums text-slate-400 dark:text-slate-400">
            {tasks.length}
          </span>
        </button>

        {epics.length === 0 && (
          <div className="px-2.5 py-3 text-xs leading-relaxed text-slate-400 dark:text-slate-400">
            {T.nav.sidebar.emptyTitle}<br />
            {T.nav.sidebar.emptyHint}
          </div>
        )}

        {epics.map(epic => {
          const s = stat.get(epic.id)!
          const active = selectedEpicId === epic.id && !selectedTaskId
          const kids = childrenOf.get(epic.id) ?? []
          const open = expanded.has(epic.id) || autoOpen === epic.id
          return (
            <div key={epic.id} className="mb-0.5">
            <div className={cx('flex items-start rounded-md',
              active ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800')}>
            <button
              onClick={e => { e.stopPropagation(); toggle(epic.id) }}
              disabled={!kids.length}
              aria-label={open ? T.nav.sidebar.collapseEpic : T.nav.sidebar.expandEpic}
              aria-expanded={open}
              className={cx('w-6 shrink-0 py-2.5 text-xs',
                kids.length
                  ? 'text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
                  : 'text-transparent')}>
              {open ? '▾' : '▸'}
            </button>
            <button
              onClick={() => onSelectEpic(epic.id)}
              title={s.hasChildren
                ? T.nav.sidebar.epicSummary(epic.title, s.done, s.total)
                : epic.title}
              className="block min-w-0 flex-1 rounded-md py-2 pr-2.5 text-left">
              <div className="flex items-center gap-2">
                <span className={cx(
                  'min-w-0 flex-1 truncate text-sm',
                  active
                    ? 'font-medium text-slate-800 dark:text-slate-100'
                    : 'text-slate-700 dark:text-slate-300'
                )}>{epic.title}</span>
                {/* 問題數排在逾期前面：問題是「這裡有多少事情壞了」，
                    逾期是「有多少事情在等外面」，兩件事分開標，不要合成一個數字 */}
                {s.bugs > 0 && (
                  <span title={T.nav.sidebar.epicBugs(s.bugs)}
                        className="shrink-0 rounded bg-rose-100 px-1 text-[10px] font-medium text-rose-700
                                   dark:bg-rose-500/15 dark:text-rose-300">
                    {T.nav.sidebar.bugBadge(s.bugs)}
                  </span>
                )}
                {s.overdue > 0 && (
                  <span title={T.nav.sidebar.epicOverdue(s.overdue)}
                        className="shrink-0 rounded bg-red-100 px-1 text-[10px] font-medium text-red-700
                                   dark:bg-red-500/15 dark:text-red-300">
                    {s.overdue}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <span className={cx('block h-full',
                          s.progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                        style={{ width: `${s.progress}%` }} />
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400 dark:text-slate-400">
                  {s.progress}%
                </span>
                {s.hasChildren && (
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400 dark:text-slate-400">
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
                  title={T.nav.sidebar.taskTitle(kid.ref, kid.title)}
                  aria-current={on ? 'true' : undefined}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-left text-[13px]',
                    on ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                       : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:text-slate-400 '
                         + 'dark:hover:bg-slate-800 dark:hover:text-slate-300'
                  )}>
                  <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full',
                    kid.progress >= 100 ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')} />
                  <span className="min-w-0 flex-1 truncate">{kid.title}</span>
                  {bugsUnder(kid.id) > 0 && (
                    <span title={T.nav.sidebar.taskBugs(bugsUnder(kid.id))}
                          className="shrink-0 rounded bg-rose-100 px-1 text-[10px] font-medium text-rose-700
                                     dark:bg-rose-500/15 dark:text-rose-300">
                      {T.nav.sidebar.bugBadge(bugsUnder(kid.id))}
                    </span>
                  )}
                  {kid.inquiryState === 'OVERDUE' && (
                    <span title={T.nav.sidebar.taskOverdue}
                          className="shrink-0 text-[11px] text-red-600 dark:text-red-400">⚠️</span>
                  )}
                </button>
              )
            })}
            </div>
          )
        })}

        {looseCount > 0 && (
          <div className="mt-2 px-2.5 text-[11px] leading-snug text-slate-400 dark:text-slate-400">
            {T.nav.sidebar.loose(looseCount)}
          </div>
        )}

        {adding ? (
          <div className="mt-2 space-y-1.5 rounded-md bg-slate-50 p-2 dark:bg-slate-800">
            <Input value={title} onChange={e => setTitle(e.target.value)}
                   placeholder={T.nav.sidebar.epicNamePlaceholder} autoFocus
                   onKeyDown={e => {
                     if (e.key === 'Enter' && title.trim()) create.mutate(title.trim())
                     if (e.key === 'Escape') { setAdding(false); setTitle('') }
                   }} />
            <div className="flex gap-1">
              <Button variant="primary" className="flex-1 justify-center text-xs"
                      disabled={!title.trim() || create.isPending}
                      onClick={() => create.mutate(title.trim())}>{T.common.create}</Button>
              <Button className="text-xs" onClick={() => { setAdding(false); setTitle('') }}>
                {T.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} disabled={!project}
                  className="mt-1 w-full rounded-md px-2.5 py-2 text-left text-sm text-slate-400
                             hover:bg-slate-50 disabled:opacity-50
                             dark:text-slate-400 dark:hover:bg-slate-800">
            ＋ {T.nav.sidebar.addEpic}
          </button>
        )}
      </nav>

    </aside>
  )
}
