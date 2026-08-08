import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Project, type ProjectParam, type Task } from '../lib/api'
import { canBeUnder, typesAllowedUnder } from '../lib/hierarchy'
import { rollup } from '../lib/rollup'
import { T } from '../strings'
import { useUnreadNotifications } from '../lib/useUnreadNotifications'
import { Button, Input, Select, ColorOption, readableColor, cx } from './ui'
import { useTheme } from '../lib/theme'

/**
 * Ref: CR-006 (專案樹狀側欄架構與折疊狀態持久化，詳見 CHANGELOG.md)
 */

/**
 * 收折狀態存在瀏覽器。
 *
 * 「側欄要不要收起來」是看螢幕決定的 —— 在筆電上為了甘特圖寬一點而收起來的人，
 * 換到大螢幕未必想收。存進帳號會讓兩台裝置互相蓋掉，跟深色模式同一個道理。
 */
function sortTasksTopologically(taskList: Task[], edges: Array<{ sourceId: string; targetId: string }>, allTasks?: Task[]): Task[] {
  if (!taskList.length) return []
  const itemMap = new Map(taskList.map(t => [t.id, t]))

  // 建立所有任務的父子關係映射
  const parentOfMap = new Map<string, string>()
  const hasKidsSet = new Set<string>()
  if (allTasks) {
    for (const t of allTasks) {
      if (t.parentId) {
        parentOfMap.set(t.id, t.parentId)
        hasKidsSet.add(t.parentId)
      }
    }
  }

  // 判斷是否為事件框或框內事件（僅以實際階層包含關係判定，不再依據「類型」欄位）
  const isBoxedOrInBox = (t: Task) => !!t.parentId || hasKidsSet.has(t.id)

  const comparePriority = (a: Task, b: Task) => {
    // 1. 事件框／框內事件優先於散落無框獨立事件
    const boxA = isBoxedOrInBox(a) ? 1 : 0
    const boxB = isBoxedOrInBox(b) ? 1 : 0
    if (boxA !== boxB) return boxB - boxA

    // 2. 基本順序：依據開任務的編號順序 (MRG-1, MRG-2, MRG-3...)
    const numA = a.number ?? 0
    const numB = b.number ?? 0
    if (numA !== numB) return numA - numB

    return a.ref.localeCompare(b.ref, undefined, { numeric: true })
  }

  // 將子任務的連線向上映射至頂層大項目，確保跨子任務連線能正確影響大項目的先後排序
  const epicEdges: Array<{ sourceId: string; targetId: string }> = []
  for (const e of edges) {
    let src = e.sourceId
    let tgt = e.targetId
    while (parentOfMap.has(src) && !itemMap.has(src)) {
      src = parentOfMap.get(src)!
    }
    while (parentOfMap.has(tgt) && !itemMap.has(tgt)) {
      tgt = parentOfMap.get(tgt)!
    }
    if (itemMap.has(src) && itemMap.has(tgt) && src !== tgt) {
      epicEdges.push({ sourceId: src, targetId: tgt })
    }
  }

  // 找出有參與關聯的 ID
  const connectedIds = new Set<string>()
  for (const e of epicEdges) {
    connectedIds.add(e.sourceId)
    connectedIds.add(e.targetId)
  }

  // 分離出「有關聯」與「無關聯」兩群
  const connectedTasks = taskList.filter(t => connectedIds.has(t.id))
  const unconnectedTasks = taskList.filter(t => !connectedIds.has(t.id)).sort(comparePriority)

  // 如果全都沒有關聯，依據「事件框優先」與 rank/ref 排序後回傳
  if (connectedTasks.length === 0) return [...taskList].sort(comparePriority)

  const inDegree = new Map<string, number>()
  const childrenMap = new Map<string, string[]>()
  
  for (const t of connectedTasks) {
    inDegree.set(t.id, 0)
    childrenMap.set(t.id, [])
  }
  
  for (const e of epicEdges) {
    childrenMap.get(e.sourceId)?.push(e.targetId)
    inDegree.set(e.targetId, (inDegree.get(e.targetId) ?? 0) + 1)
  }

  // 根節點（沒有入度的事件），依據事件框優先度與 rank/ref 排序
  const roots = connectedTasks.filter(t => (inDegree.get(t.id) ?? 0) === 0).sort(comparePriority)

  const connectedResult: Task[] = []
  const visited = new Set<string>()

  // 深度優先走訪 (DFS)，當上游連線到下游時，下游緊貼在預設上游正後方，中間不插入無關事件
  function dfs(id: string) {
    if (visited.has(id)) return
    visited.add(id)
    const task = itemMap.get(id)
    if (task) connectedResult.push(task)

    const nextTasks = (childrenMap.get(id) ?? [])
      .map(nid => itemMap.get(nid))
      .filter((t): t is Task => !!t && !visited.has(t.id))
      .sort(comparePriority)

    for (const next of nextTasks) {
      dfs(next.id)
    }
  }

  for (const root of roots) {
    dfs(root.id)
  }

  // 預防環形依賴或遺漏的有連線節點
  for (const t of connectedTasks) {
    if (!visited.has(t.id)) {
      connectedResult.push(t)
    }
  }

  // 無關聯的事件統一排在 Menu 最下方！
  return [...connectedResult, ...unconnectedTasks]
}

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
  project, tasks, types = [], selectedEpicId, onSelectEpic, selectedTaskId, onOpenTask,
  onSwitchProject,
}: {
  project?: Project
  tasks: Task[]
  /**
   * 這個專案的任務種類。側欄每一列要標出自己是哪一種 ——
   * 少了它，最上層的大項目跟最上層的任務長得一模一樣，
   * 掛在任務底下的錯誤也看不出來跟兄弟任務有什麼不同。
   */
  types?: ProjectParam[]
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
  const { resolved } = useTheme()
  const dark = resolved === 'dark'
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  const typeList = useMemo(() => types.length ? types : [
    { key: 'EPIC', name: '大項目', color: '#d97706' },
    { key: 'TASK', name: '任務', color: '#3178c6' },
    { key: 'BUG', name: '問題', color: '#dc2626' },
    { key: 'MILESTONE', name: '里程碑', color: '#8b5cf6' }
  ], [types])

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<boolean>(() => storedCollapsed())

  const { data: graphData } = useQuery({
    queryKey: ['graph', project?.id],
    queryFn: () => Api.graph(project!.id),
    enabled: !!project?.id,
  })

  const { epics, stat, looseCount, childrenOf, bugsUnder, overdueIn, inquiriesIn } = useMemo(() => {
    const edges = graphData?.edges ?? []
    const ids = new Set(tasks.map(t => t.id))
    const rawEpics = tasks.filter(t => !t.parentId)
    const epics = sortTasksTopologically(rawEpics, edges, tasks)
    const rolled = rollup(tasks)

    // 子樹裡有沒有「單位逾期未回」——要走完整棵子樹，不能只看直屬子任務
    const rawKids = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.parentId || !ids.has(t.parentId)) continue
      const a = rawKids.get(t.parentId) ?? []; a.push(t); rawKids.set(t.parentId, a)
    }

    const kids = new Map<string, Task[]>()
    for (const [pId, list] of rawKids.entries()) {
      kids.set(pId, sortTasksTopologically(list, edges, tasks))
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
     * 這一支有幾件**還沒逾期**的對外詢問（含自己）。
     *
     * 刻意扣掉逾期的：逾期已經有自己的徽章了，兩邊都算的話同一件事會被數兩次，
     * 而「外 3 逾 1」也會被讀成「總共四件」。分開之後兩個數字加起來
     * 才剛好是「這一支發出去的對外詢問」的總數。
     *
     * **已回覆的不算**：那件事已經完成了。這兩顆徽章同時是「還能不能結案」的
     * 儀表板（見 AGENTS.md「還有對外詢問沒回，就不能完成」）——
     * 把已回覆的算進來的話，任務只要問過一次就永遠有數字、永遠結不了案。
     */
    const inquiriesIn = (rootId: string): number => {
      let n = 0
      const walk = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return
        seen.add(id)
        const self = tasks.find(t => t.id === id)
        if (self?.inquiryState === 'AWAITING' || self?.inquiryState === 'PARTIAL') n++
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
    return { epics, stat, looseCount, childrenOf: kids, bugsUnder, overdueIn, inquiriesIn }
  }, [tasks])

  /** 一列任務的問題數：底下的，加上自己（如果它本身就是一張問題） */
  const bugCount = (t: Task) => bugsUnder(t.id) + (t.type === 'BUG' ? 1 : 0)

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

  // 當選擇新任務時，將其大項目自動寫入 expanded 集合，但不強制覆蓋使用者的手動折疊
  useEffect(() => {
    if (autoOpen) {
      setExpanded(prev => {
        if (prev.has(autoOpen)) return prev
        const next = new Set(prev)
        next.add(autoOpen)
        return next
      })
    }
  }, [autoOpen])

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  /**
   * 只展開、不收合。
   *
   * 在某一列底下新增子任務之後一定要展開那一列 —— 收著的話，
   * 建立完什麼都沒有變，看的人不知道剛剛那張跑去哪了。
   */
  function expand(id: string) {
    setExpanded(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }

  function setCollapse(v: boolean) {
    setCollapsed(v)
    rememberCollapsed(v)
  }

  const [createType, setCreateType] = useState<string>('EPIC')

  const create = useMutation({
    mutationFn: (v: { title: string; type: string }) =>
      Api.createTask(project!.id, { title: v.title, type: v.type }),
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

        {epics.map(epic => (
          <TreeNode
            key={epic.id}
            task={epic}
            depth={0}
            projectId={project?.id}
            childrenOf={childrenOf}
            stat={stat.get(epic.id)}
            bugsUnder={bugsUnder}
            overdueIn={overdueIn}
            inquiriesIn={inquiriesIn}
            types={types}
            expanded={expanded}
            autoOpen={autoOpen}
            toggle={toggle}
            expand={expand}
            selectedEpicId={selectedEpicId}
            selectedTaskId={selectedTaskId}
            onSelectEpic={onSelectEpic}
            onOpenTask={onOpenTask}
          />
        ))}

        {looseCount > 0 && (
          <div className="mt-2 px-2.5 text-[11px] leading-snug text-slate-400 dark:text-slate-400">
            {T.nav.sidebar.loose(looseCount)}
          </div>
        )}

        {adding ? (
          <div className="mt-2 space-y-1.5 rounded-md bg-slate-50 p-2 dark:bg-slate-800">
            <div className="flex gap-1.5 items-center">
              <span className="text-xs text-slate-500 shrink-0">類型：</span>
              <Select
                value={createType}
                onChange={e => setCreateType(e.target.value)}
                style={typeList.find(t => t.key === createType)?.color ? { color: readableColor(typeList.find(t => t.key === createType)?.color, dark) } : undefined}
                className="text-xs py-1 flex-1 font-medium"
              >
                {typeList.map(t => (
                  <ColorOption key={t.key} value={t.key} color={t.color} dark={dark}>
                    {t.name}
                  </ColorOption>
                ))}
              </Select>
            </div>
            <Input value={title} onChange={e => setTitle(e.target.value)}
                   placeholder="事件名稱" autoFocus
                   onKeyDown={e => {
                     if (e.key === 'Enter' && title.trim()) create.mutate({ title: title.trim(), type: createType })
                     if (e.key === 'Escape') { setAdding(false); setTitle('') }
                   }} />
            <div className="flex gap-1">
              <Button variant="primary" className="flex-1 justify-center text-xs"
                      disabled={!title.trim() || create.isPending}
                      onClick={() => create.mutate({ title: title.trim(), type: createType })}>{T.common.create}</Button>
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
            ＋ 新增事件
          </button>
        )}
      </nav>

    </aside>
  )
}

/**
 * 樹上的一列，會遞迴畫出自己底下的每一層。
 *
 * **為什麼要遞迴**：原本只畫兩層（大項目 → 直屬子項），所以掛在任務底下的錯誤
 * 根本不會出現在側欄上 —— 而種類的上下關係就規定錯誤只能掛在任務底下
 * （見 AGENTS.md）。畫不出來的話，左邊看到的結構跟實際的結構是兩回事。
 *
 * 深度只影響縮排與字級：最上層那一列（大項目）多一條進度條與 x/y，
 * 底下每一層都是同一種緊湊的樣子，再深也不會多出新花樣。
 */
function TreeNode({
  task, depth, projectId, childrenOf, stat, bugsUnder, overdueIn, inquiriesIn, types,
  expanded, autoOpen, toggle, expand, selectedEpicId, selectedTaskId, onSelectEpic, onOpenTask,
}: {
  task: Task
  depth: number
  /** 沒有專案就畫不出「＋」（建立要它） */
  projectId?: string
  types: ProjectParam[]
  childrenOf: Map<string, Task[]>
  /** 只有最上層那一列有：進度與 x/y 個已完成 */
  stat?: { progress: number; done: number; total: number; hasChildren: boolean }
  bugsUnder: (id: string) => number
  overdueIn: (id: string) => number
  inquiriesIn: (id: string) => number
  expanded: Set<string>
  autoOpen: string | null
  toggle: (id: string) => void
  /** 新增完子任務要把這一列展開，不然看不到剛剛建的那張 */
  expand: (id: string) => void
  selectedEpicId: string | null
  selectedTaskId: string | null
  onSelectEpic: (id: string) => void
  onOpenTask: (id: string) => void
}) {
  const qc = useQueryClient()
  const [addingChild, setAddingChild] = useState(false)
  const [childTitle, setChildTitle] = useState('')
  const kids = childrenOf.get(task.id) ?? []
  const open = expanded.has(task.id)
  const kind = types.find(t => t.key === task.type)
  const kindName = kind?.name ?? task.type
  const kindColor = kind?.color ?? '#94a3b8'
  const isRoot = depth === 0
  const active = isRoot
    ? selectedEpicId === task.id && !selectedTaskId
    : task.id === selectedTaskId

  const { unreadTaskIds, markTaskRead } = useUnreadNotifications()
  const hasUnread = unreadTaskIds.has(task.id)

  /*
   * 收著的時候標整支子樹的量，展開之後只標「這一列自己」的 ——
   * 底下每一列都各自標著自己的數字了，上面再留一個總數，
   * 同一個畫面就有兩層數字在互相解釋。
   *
   * 錯誤**不含自己**：一張錯誤本來就長得像錯誤（種類徽章、縮排位置都看得到），
   * 旁邊再標一個「錯 1」只會讓人以為它底下還有東西。
   * 逾期含自己 —— 那是狀態不是身分，不標就看不出來。
   */
  const bugs = open ? 0 : bugsUnder(task.id)
  const overdue = open
    ? (task.inquiryState === 'OVERDUE' ? 1 : 0)
    : overdueIn(task.id)
  const asked = open
    ? (task.inquiryState === 'AWAITING' || task.inquiryState === 'PARTIAL' ? 1 : 0)
    : inquiriesIn(task.id)

  /*
   * 「＋」要建的種類 —— 合不合法一律問 `lib/hierarchy.ts`，不要在這裡自己再寫一套
   * （後端 `apps/api/src/lib/hierarchy.ts` 才是守門員，兩邊的判斷要對得起來，
   * 不然這顆按鈕按下去只會拿到 400）。
   *
   * 優先挑「任務」：掛在大項目底下就是任務，掛在任務底下就是子任務，
   * 兩種都是這顆按鈕最常見的用途。任務不合法時退而求其次挑第一個合法的種類；
   * 一種都不合法就整顆不畫 —— 畫一顆按下去必定被拒絕的按鈕比沒有更糟。
   */
  const addType = useMemo(() => {
    const allowed = typesAllowedUnder(types, task.type)
    const pick = allowed.find(t => t.key === 'TASK') ?? allowed[0]
    if (pick) return pick.key
    // 種類清單還沒載進來（types 是選填的）：直接問規則本身，別讓按鈕整個消失
    return types.length === 0 && canBeUnder('TASK', task.type) ? 'TASK' : null
  }, [types, task.type])

  const createChild = useMutation({
    mutationFn: (t: string) =>
      Api.createTask(projectId!, { title: t, type: addType!, parentId: task.id }),
    onSuccess: () => {
      setChildTitle(''); setAddingChild(false)
      expand(task.id)
      qc.invalidateQueries({ queryKey: ['tasks', projectId!] })
    },
  })

  function cancelAdd() { setAddingChild(false); setChildTitle('') }

  return (
    <div className={isRoot ? 'mb-0.5' : undefined}>
      <div className={cx('group/row flex items-start rounded-md',
        active ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800',
        hasUnread && 'pmflow-flash')}>

        {/* 沒有子項的列一樣佔一格箭頭的寬度，不然同一層的文字會左右參差 */}
        <button
          onClick={e => { e.stopPropagation(); toggle(task.id) }}
          disabled={!kids.length}
          aria-label={open ? T.nav.sidebar.collapseEpic : T.nav.sidebar.expandEpic}
          aria-expanded={open}
          style={{ marginLeft: depth * 12 }}
          className={cx('w-6 shrink-0 text-xs', isRoot ? 'py-2.5' : 'py-1.5',
            kids.length
              ? 'text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
              : 'text-transparent')}>
          {open ? '▾' : '▸'}
        </button>

        <button
          onClick={() => {
            if (hasUnread) markTaskRead(task.id)
            if (isRoot) onSelectEpic(task.id)
            onOpenTask(task.id)
          }}
          title={isRoot && stat?.hasChildren
            ? T.nav.sidebar.epicSummary(task.title, stat.done, stat.total)
            : T.nav.sidebar.taskTitle(task.ref, task.title)}
          aria-current={!isRoot && active ? 'true' : undefined}
          className={cx('block min-w-0 flex-1 rounded-md pr-2.5 text-left',
                        isRoot ? 'py-2' : 'py-1.5')}>
          <div className="flex items-center gap-2">
            {/*
              * 每一列前面一條種類色的細槓（顏色是他在系統參數頁自己挑的）。
              * 沒有它的話，最上層的大項目跟最上層的任務長得一模一樣，
              * 掛在任務底下的錯誤也看不出來跟兄弟任務有什麼不同。
              *
              * 只當細槓、不當底色也不當文字色：顏色是使用者挑的，深淺不受控，
              * 拿去當底色在深色模式下會有一半讀不到（跟清單、週檢視同一套畫法）。
              */}
            <span className={cx('shrink-0 rounded-full', isRoot ? 'h-4 w-1' : 'h-3 w-0.5')}
                  title={kindName}
                  style={{ background: kindColor }} />
            <span className={cx('min-w-0 flex-1 truncate',
              isRoot ? 'text-sm' : 'text-[13px]',
              active
                ? isRoot
                  ? 'font-medium text-slate-800 dark:text-slate-100'
                  : 'font-medium text-blue-700 dark:text-blue-300'
                : isRoot
                  ? 'text-slate-700 dark:text-slate-300'
                  : 'text-slate-500 dark:text-slate-400'
            )}>{task.title}</span>

            {/*
              * 做完了才畫一個勾。沒做完就不畫 —— 前面那條槓已經佔住
              * 「這一列是什麼」的位置，再放一個灰點只是多一個要解讀的東西。
              *
              * 用勾不用綠點：綠點得先知道規則才看得懂（他第一次看到就問了
              * 「綠色點是什麼意思」），勾不必解釋。
              */}
            {!isRoot && task.progress >= 100 && (
              <span aria-hidden title={T.nav.sidebar.doneDot}
                    className="shrink-0 text-[11px] leading-none text-emerald-600
                               dark:text-emerald-400">✓</span>
            )}

            {/* 錯誤排在逾期前面：一個是「這裡有多少事情壞了」，
                一個是「有多少事情在等外面回」，兩件事分開標 */}
            {bugs > 0 && (
              <span title={T.nav.sidebar.bugsUnder(bugs)}
                    className="shrink-0 rounded bg-rose-100 px-1 text-[10px] font-medium text-rose-700
                               dark:bg-rose-500/15 dark:text-rose-300">
                {T.nav.sidebar.bugBadge(bugs)}
              </span>
            )}
            {/* 「外」排在「逾」前面，而且已經扣掉逾期的那幾件 ——
                兩個數字加起來才是這一支發出去的對外詢問總數，不會重複算 */}
            {asked > 0 && (
              <span title={T.nav.sidebar.askedUnder(asked)}
                    className="shrink-0 rounded bg-blue-100 px-1 text-[10px] font-medium text-blue-700
                               dark:bg-blue-500/15 dark:text-blue-300">
                {T.nav.sidebar.askedBadge(asked)}
              </span>
            )}
            {overdue > 0 && (
              <span title={T.nav.sidebar.overdueUnder(overdue)}
                    className="shrink-0 rounded bg-red-100 px-1 text-[10px] font-medium text-red-700
                               dark:bg-red-500/15 dark:text-red-300">
                {T.nav.sidebar.overdueBadge(overdue)}
              </span>
            )}
          </div>

          {/* 進度條只有最上層那一列有 —— 每一層都畫的話，側欄會變成一片條 */}
          {isRoot && stat && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <span className={cx('block h-full',
                        stat.progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                      style={{ width: `${stat.progress}%` }} />
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-slate-400 dark:text-slate-400">
                {stat.progress}%
              </span>
              {stat.hasChildren && (
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400 dark:text-slate-400">
                  {stat.done}/{stat.total}
                </span>
              )}
            </div>
          )}
        </button>

        {/*
          * 滑鼠移到這一列才冒出來的「＋」。
          *
          * 一直畫出來的話整排右邊會變成一面按鈕牆，把標題與錯／外／逾三顆徽章擠掉。
          * 但**位子一直留著**（用 opacity 不用條件渲染）—— 進出滑鼠就重排一次的話，
          * 標題會跟著抽動，比按鈕牆更難看。
          *
          * `focus:opacity-100` 不能省：只認 hover 的話，用鍵盤 Tab 過來的人
          * 會停在一顆看不見的按鈕上，永遠不知道它在那裡。
          */}
        <button
          onClick={e => { e.stopPropagation(); onOpenTask(task.id) }}
          title="編輯詳細內容"
          aria-label="編輯詳細內容"
          className={cx('w-6 shrink-0 rounded text-xs opacity-0 transition-opacity',
            'group-hover/row:opacity-100 focus:opacity-100',
            isRoot ? 'py-2.5' : 'py-1.5',
            'text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300')}>
          ✏️
        </button>
        {addType && projectId && !addingChild && (
          <button
            onClick={e => { e.stopPropagation(); expand(task.id); setAddingChild(true) }}
            title={T.nav.sidebar.addSubtaskUnder(task.title)}
            aria-label={T.nav.sidebar.addSubtaskUnder(task.title)}
            className={cx('w-6 shrink-0 rounded text-xs opacity-0 transition-opacity',
              'group-hover/row:opacity-100 focus:opacity-100',
              isRoot ? 'py-2.5' : 'py-1.5',
              'text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300')}>
            ＋
          </button>
        )}
      </div>

      {/* 就地展開的輸入框，縮排到子項那一層 —— 它建出來的東西會落在那裡 */}
      {addingChild && (
        <div className="my-1 space-y-1.5 rounded-md bg-slate-50 p-2 dark:bg-slate-800"
             style={{ marginLeft: (depth + 1) * 12 + 24 }}>
          <Input value={childTitle} onChange={e => setChildTitle(e.target.value)}
                 placeholder={T.nav.sidebar.subtaskNamePlaceholder} autoFocus
                 onKeyDown={e => {
                   if (e.key === 'Enter' && childTitle.trim()) createChild.mutate(childTitle.trim())
                   if (e.key === 'Escape') cancelAdd()
                 }} />
          <div className="flex gap-1">
            <Button variant="primary" className="flex-1 justify-center text-xs"
                    disabled={!childTitle.trim() || createChild.isPending}
                    onClick={() => createChild.mutate(childTitle.trim())}>
              {T.common.create}
            </Button>
            <Button className="text-xs" onClick={cancelAdd}>{T.common.cancel}</Button>
          </div>
        </div>
      )}

      {open && kids.map(kid => (
        <TreeNode
          key={kid.id}
          task={kid}
          depth={depth + 1}
          projectId={projectId}
          childrenOf={childrenOf}
          bugsUnder={bugsUnder}
          overdueIn={overdueIn}
          inquiriesIn={inquiriesIn}
          types={types}
          expanded={expanded}
          autoOpen={autoOpen}
          toggle={toggle}
          expand={expand}
          selectedEpicId={selectedEpicId}
          selectedTaskId={selectedTaskId}
          onSelectEpic={onSelectEpic}
          onOpenTask={onOpenTask}
        />
      ))}

      {/* 含有多個子事件的事件框/大項目，在其最後一個子事件後面加上分隔線 */}
      {isRoot && kids.length > 0 && (
        <div className="my-2 border-b border-slate-200 dark:border-slate-700/60" />
      )}
    </div>
  )
}
