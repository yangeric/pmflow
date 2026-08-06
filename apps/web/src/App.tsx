import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api, type AppNotification, type Task, type WorkspaceRole } from './lib/api'
import { useAuth } from './lib/auth'
import { T } from './strings'
import { Button, Spinner, cx } from './components/ui'
import { useRemembered } from './lib/remember'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskDrawer } from './components/TaskDrawer'
import { EpicSidebar } from './components/EpicSidebar'
import { NotificationBell } from './components/NotificationBell'
import { UserMenu } from './components/UserMenu'
import Login from './pages/Login'
import Board from './pages/Board'
import ListView from './pages/List'
// dhtmlx-gantt 有 700KB+，只在真的切到甘特頁時才載入，
// 不要讓只想看看板的人也付這個代價
const GanttView = lazy(() => import('./pages/Gantt'))
// React Flow 同理，只有關聯圖用得到
const GraphView = lazy(() => import('./pages/Graph'))
import CalendarView from './pages/Calendar'
import InquiryBoard from './pages/InquiryBoard'
import ProjectPicker from './pages/ProjectPicker'
import MembersPanel from './components/MembersPanel'
import MembersView from './pages/Members'
import ProjectSettings from './components/ProjectSettings'
import AccountPanel from './components/AccountPanel'
import AdminPanel from './components/AdminPanel'
import WeekView from './pages/Week'
// 儀表板一進去就要打兩支要算的 API，圖表本身也只有這一頁用得到，
// 跟甘特、關聯圖一樣延後載入
const DashboardView = lazy(() => import('./pages/Dashboard'))

type View = 'list' | 'board' | 'week' | 'calendar' | 'gantt' | 'graph' | 'dashboard'
  | 'inquiry' | 'members' | 'memberAdmin' | 'settings'

/**
 * 帳號設定與系統管理不是專案底下的視圖 —— 沒選專案也要進得去，
 * 所以獨立成一層蓋在最上面，離開就回到原本看到的畫面。
 */
type AccountView = 'profile' | 'admin' | null

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'list', label: T.nav.views.list },
  { key: 'board', label: T.nav.views.board },
  // 週檢視排在行事曆前面：月曆看得到日期，週檢視回答的是「這禮拜卡在哪一關」，
  // 後者是每週例行要問的，翻開的次數比月曆多
  { key: 'week', label: T.nav.views.week },
  { key: 'calendar', label: T.nav.views.calendar },
  { key: 'gantt', label: T.nav.views.gantt },
  { key: 'graph', label: T.nav.views.graph },
  // 儀表板排在幾張「看任務」的圖後面：它看的是整個專案的走勢，
  // 不是同一批任務的另一種排法，翻它的時機也不一樣（回報進度的時候才看）
  { key: 'dashboard', label: T.nav.views.dashboard },
  // 發文追蹤放在這一排：它跟其他頁籤一樣是「這個專案的任務」的一種看法 ——
  // 只是看的是「發出去的事情回了沒」。不再是跨專案的入口。
  { key: 'inquiry', label: T.nav.views.inquiry },
  /*
   * 成員原本刻意不在這一排（理由是「這排是同一批任務的不同看法，成員是專案設定」）。
   * 2026-08-06 推翻：成員頁現在回答的是「這個人手上有什麼、以前經手過什麼」，
   * 那就是同一批任務按人切的一種看法，該站到這一排來。
   *
   * 頭像選單那個入口留著，但指向的是**管理**成員（改角色、核准加入申請），
   * 走 `memberAdmin` —— 看人跟管人是兩件事，混在一頁只會兩邊都難用。
   */
  { key: 'members', label: T.nav.views.members },
]

/**
 * 這幾個畫面不吃側欄「大項目」那個篩選 —— 發文追蹤與成員本來就跟大項目無關，
 * 儀表板則是整個專案一起算的。停在這些畫面上點大項目，按下去會沒有任何反應，
 * 所以一律先回清單。
 */
const NOT_FILTERED_BY_EPIC: View[] = [
  'inquiry', 'members', 'memberAdmin', 'settings', 'dashboard',
]

export default function App() {
  const { user, workspaces, ready, logout } = useAuth()
  // projectId 為 null＝還沒選專案，顯示選擇頁。
  // 專案切換刻意只發生在這一層，側欄不再放專案清單。
  const [projectId, setProjectId] = useState<string | null>(null)
  const [view, setView] = useState<View>('list')
  const [openTask, setOpenTask] = useState<string | null>(null)
  /**
   * 從通知點進來的那張任務，要閃紅框指出來是哪一張。
   *
   * 存的是 id 不是布林值：連點兩則不同的通知時，第二則要能重新觸發
   * （`key` 換掉 → 元素重掛 → 動畫從頭跑）。
   *
   * **不設定時器自動收掉。** 人不見得正看著螢幕，閃完就退場等於沒發生過 ——
   * 要等他真的在那張任務上動一下（點、按鍵、或關掉）才清。
   * 動畫三下就停，之後留著一圈靜止的紅框（見 index.css 的 `.pmflow-flash`）。
   */
  const [flashTask, setFlashTask] = useState<string | null>(null)
  const [account, setAccount] = useState<AccountView>(null)

  /**
   * 換人登入就回到選擇頁。
   *
   * 快取由 AuthProvider 清掉了，但「現在開著哪個專案」是這裡的 state，
   * 不歸零的話新登入的人會停在前一個人的專案上，然後對著一堆 403 發呆。
   * 這是 React 文件講的「render 期間依變化調整 state」，比 effect 少一次繪製。
   */
  const [seenUserId, setSeenUserId] = useState<string | null>(user?.id ?? null)
  if ((user?.id ?? null) !== seenUserId) {
    setSeenUserId(user?.id ?? null)
    setProjectId(null)
    setView('list')
    setOpenTask(null)
    setAccount(null)
  }

  const { data: projectsData } = useQuery({
    queryKey: ['projects'], queryFn: Api.projects, enabled: !!user,
  })
  const projects = projectsData?.projects ?? []

  if (!ready) return <Spinner label={T.nav.starting} />
  if (!user) return <Login />

  /**
   * 點通知就跳到那件事發生的地方 —— 通知只是入口，看不到內容的話等於沒通知。
   *
   * 導覽狀態都在這一層，所以鈴鐺不管畫在哪裡（選擇頁、側欄、帳號設定），
   * 都把選中的那一則交回來由這裡處理。
   */
  const openNotification = (n: AppNotification) => {
    setAccount(null)
    if (!n.projectId) return
    setProjectId(n.projectId)
    setOpenTask(n.taskId)
    /*
     * 閃一下紅框指出「就是這一張」。一次點下去畫面上換掉太多東西
     * （可能換專案、換頁籤、再開抽屜），眼睛不知道該看哪裡。
     * 動畫本身在 index.css 的 `.pmflow-flash`，閃三下就停。
     */
    setFlashTask(n.taskId)
    // 有人來敲門要在成員**管理**那一頁才核准得了（頁籤上那個成員頁只看不管）
    setView(n.kind === 'JOIN_REQUESTED' ? 'memberAdmin' : 'list')
  }
  const bell = <NotificationBell onOpen={openNotification} />

  const workspaceId = workspaces[0]?.id ?? projects[0]?.workspaceId ?? ''
  // 「系統管理」只給工作區的擁有者與管理者看到。後端也會再擋一次，
  // 這裡收起來只是不要讓人按了才被拒絕
  const isWorkspaceAdmin = ['OWNER', 'ADMIN'].includes(workspaces[0]?.role ?? '')
  const pendingJoins = projects.find(p => p.id === projectId)?.pendingJoinRequestCount ?? 0
  // 系統參數是「改這個專案的規則」，不是「看這個專案的內容」，所以只給管理者。
  // 後端一樣擋著（canManage），這裡收起來只是不要讓人按了才被拒絕
  const canManageProject = projects.find(p => p.id === projectId)?.role === 'MANAGER'

  // 成員、系統參數、帳號設定、系統管理、外觀、登出都收在右上角的頭像底下
  // （見 components/UserMenu.tsx）。前兩項只有人在專案裡的時候才給 ——
  // 沒選專案時「這個專案的成員」與「這個專案的參數」都是空話
  const userMenu = (
    <UserMenu
      userName={user.displayName}
      isWorkspaceAdmin={isWorkspaceAdmin}
      onAccount={() => setAccount('profile')}
      onAdmin={() => setAccount('admin')}
      onLogout={logout}
      onMembers={projectId
        ? () => { setAccount(null); setView('memberAdmin'); setOpenTask(null) }
        : undefined}
      onSettings={projectId && canManageProject
        ? () => { setAccount(null); setView('settings'); setOpenTask(null) }
        : undefined}
      pendingJoins={pendingJoins}
    />
  )

  // ── 帳號設定／系統管理：蓋在最上面，離開就回到原本的畫面 ──
  if (account) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 border-b border-slate-200 bg-white px-4 py-2.5
                           dark:border-slate-700 dark:bg-slate-900">
          <Button variant="ghost" onClick={() => setAccount(null)}>← {T.common.back}</Button>
          <span className="mx-2 text-slate-200 dark:text-slate-500">|</span>
          <AccountTab active={account === 'profile'}
                      onClick={() => setAccount('profile')}>{T.nav.accountSettings}</AccountTab>
          {isWorkspaceAdmin && (
            <AccountTab active={account === 'admin'}
                        onClick={() => setAccount('admin')}>{T.nav.systemAdmin}</AccountTab>
          )}
          <div className="ml-auto flex items-center gap-2">{bell}{userMenu}</div>
        </header>
        <div className="min-h-0 flex-1">
          {account === 'profile'
            ? <AccountPanel />
            : <AdminPanel workspaceId={workspaceId}
                          myRole={(workspaces[0]?.role ?? 'MEMBER') as WorkspaceRole} />}
        </div>
      </div>
    )
  }

  // ── 還沒選專案 → 選擇頁 ──
  // 發文追蹤不再是這一頁的入口：它是專案裡的頁籤，要進到專案才看得到
  if (!projectId) {
    return (
      <ProjectPicker
        projects={projects}
        workspaceId={workspaceId}
        onPick={id => { setProjectId(id); setView('list') }}
        bell={bell}
        menu={userMenu}
      />
    )
  }

  return (
    <ProjectWorkspace
      key={projectId}
      projectId={projectId}
      workspaceId={workspaceId}
      view={view} setView={setView}
      openTask={openTask} setOpenTask={setOpenTask}
      flashTask={flashTask}
      onFlashSeen={() => setFlashTask(null)}
      onSwitchProject={() => { setProjectId(null); setView('list'); setOpenTask(null) }}
      bell={bell}
      menu={userMenu}
    />
  )
}

function AccountTab({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: ReactNode
}) {
  return (
    <button onClick={onClick}
            className={cx('rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          active
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                            : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200')}>
      {children}
    </button>
  )
}

function SortableTabItem({
  v, hidden, lastOne, toggle, P,
}: {
  v: { key: View; label: string }
  hidden: View[]
  lastOne: boolean
  toggle: (key: View) => void
  P: typeof T.nav.tabPrefs
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: v.key })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 30 : 1,
  }

  const on = !hidden.includes(v.key)
  const stuck = on && lastOne

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx(
        'flex items-center gap-1.5 rounded px-2 py-1 text-sm bg-white dark:bg-slate-800',
        'border border-slate-100 dark:border-slate-700/60',
        isDragging ? 'shadow-md border-blue-400 dark:border-blue-500' : 'hover:bg-slate-50 dark:hover:bg-slate-700/40'
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        title={P.dragHandleTip}
        aria-label={P.dragHandleTip}
        className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 touch-none px-0.5"
      >
        ≡
      </button>
      <label title={stuck ? P.keepOne : undefined}
             className={cx('flex min-w-0 flex-1 items-center gap-2',
               stuck ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
        <input type="checkbox" checked={on} disabled={stuck}
               onChange={() => toggle(v.key)}
               className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600
                          focus:ring-blue-500/40 dark:border-slate-500 dark:bg-slate-900" />
        <span className="truncate text-slate-700 dark:text-slate-200">{v.label}</span>
      </label>
    </div>
  )
}

/**
 * 頁籤右邊那顆齒輪：勾選要顯示哪幾個頁籤、拖曳調整左右順序。
 *
 * **只影響自己這台瀏覽器**，不是專案設定（見 AGENTS.md「頁籤可以自己藏起來」）。
 * 面板裡把這句話寫出來 —— 不寫的話，藏掉甘特圖的人會以為自己剛剛
 * 把全專案的甘特圖關掉了。
 *
 * **至少留一個**：全部取消勾選會讓上面整排消失，變成一個不知道怎麼救回來的畫面。
 * 剩最後一個時那一格直接 disabled，而不是按下去才跳錯誤。
 */
function TabPrefs({ hidden, setHidden, ordered, onReorder, onResetOrder, view, setView }: {
  hidden: View[]
  setHidden: (v: View[]) => void
  /** 目前的左右順序（已經把存值與 VIEWS 合併過） */
  ordered: Array<{ key: View; label: string }>
  onReorder: (activeKey: View, overKey: View) => void
  onResetOrder: () => void
  view: View
  setView: (v: View) => void
}) {
  const [open, setOpen] = useState(false)
  const P = T.nav.tabPrefs
  const shown = ordered.filter(v => !hidden.includes(v.key))
  const lastOne = shown.length <= 1

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      onReorder(active.id as View, over.id as View)
    }
  }

  function toggle(key: View) {
    const next = hidden.includes(key)
      ? hidden.filter(k => k !== key)
      : [...hidden, key]
    setHidden(next)
    // 藏掉的正好是現在看著的那一頁 → 跳到還留著的第一個，不然畫面會空掉
    if (key === view && next.includes(key)) {
      const first = VIEWS.find(v => !next.includes(v.key))
      if (first) setView(first.key)
    }
  }

  return (
    <div className="relative ml-auto">
      <button onClick={() => setOpen(o => !o)}
              title={P.open} aria-label={P.open} aria-expanded={open}
              className="rounded-md px-2 py-1.5 text-sm text-slate-400 hover:bg-slate-100
                         hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800
                         dark:hover:text-slate-200">
        ⚙
      </button>

      {open && (
        <>
          {/* 點旁邊就收起來。蓋在整個畫面上但透明，不然要按兩次才關得掉 */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-slate-200
                          bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-800">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">{P.title}</div>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-400 dark:text-slate-400">
              {P.hint}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-400 dark:text-slate-400">
              {P.orderHint}
            </p>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={ordered.map(v => v.key)} strategy={verticalListSortingStrategy}>
                <div className="mt-2 space-y-1">
                  {ordered.map(v => (
                    <SortableTabItem
                      key={v.key}
                      v={v}
                      hidden={hidden}
                      lastOne={lastOne}
                      toggle={toggle}
                      P={P}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 dark:border-slate-700/60">
              <Button variant="ghost" className="text-xs"
                      onClick={() => { setHidden([]); onResetOrder() }}>
                {P.reset}
              </Button>
              <Button variant="ghost" className="text-xs" onClick={() => setOpen(false)}>
                {P.done}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 有選定專案時的主畫面：左側大項目、右側視圖。
 * 查詢集中在這一層，側欄和主視圖吃同一份資料，不會各抓一次。
 */
function ProjectWorkspace({
  projectId, workspaceId, view: requestedView, setView, openTask, setOpenTask,
  flashTask, onFlashSeen, onSwitchProject, bell, menu,
}: {
  projectId: string
  workspaceId: string
  view: View
  setView: (v: View) => void
  openTask: string | null
  setOpenTask: (id: string | null) => void
  /** 剛從通知點進來的那張任務，要閃紅框指出來。null＝不閃 */
  flashTask: string | null
  /** 他在那張任務上動了一下，或關掉了 —— 紅框可以收走了 */
  onFlashSeen: () => void
  onSwitchProject: () => void
  /** 通知鈴鐺。由 App 建立，因為點下去要跳去哪是 App 的導覽狀態 */
  bell: ReactNode
  /** 右上角的頭像選單。同樣由 App 建立 —— 點下去是換畫面，那是 App 的事 */
  menu: ReactNode
}) {
  /** 側欄選中的大項目；null＝不篩選 */
  const [epicId, setEpicId] = useState<string | null>(null)

  /**
   * 藏起來的頁籤。**每個人自己的偏好，存這台瀏覽器**（見 AGENTS.md）——
   * 不做成專案設定：一個人嫌甘特圖礙眼把它收掉，會連帶害到同專案
   * 每天都在看甘特圖的人。跟側欄收合、行事曆勾選同一套 `lib/remember.ts`。
   */
  const [hiddenTabs, setHiddenTabs] = useRemembered<View[]>('tabs.hidden', [])
  /**
   * 頁籤由左到右的順序，一樣是自己這台瀏覽器的偏好。
   *
   * 存下來的清單**不能直接拿來用**：版本更新多一個頁籤時，舊的存值裡沒有它，
   * 照著存值畫就等於那個新頁籤永遠出不來。所以一律「先照存值排，
   * 存值裡沒有的照 VIEWS 原順序補在後面，存值裡有但已經不存在的跳過」。
   */
  const [tabOrder, setTabOrder] = useRemembered<View[]>('tabs.order', [])
  const orderedViews = useMemo(() => {
    const known = new Map(VIEWS.map(v => [v.key, v]))
    const out = tabOrder.map(k => known.get(k)).filter(v => v !== undefined)
    for (const v of VIEWS) if (!out.includes(v)) out.push(v)
    return out
  }, [tabOrder])
  const shownViews = orderedViews.filter(v => !hiddenTabs.includes(v.key))

  /**
   * 存下來的偏好可能正好藏著現在這一頁（上次藏完就關掉、或換了一台裝置），
   * 那就退到還留著的第一個 —— 不然會停在一個「上面沒有任何頁籤亮著」的畫面，
   * 看起來就像壞掉了。成員管理與系統參數不在頁籤那一排，不受影響。
   */
  const view: View = VIEWS.some(v => v.key === requestedView) && hiddenTabs.includes(requestedView)
    ? (shownViews[0]?.key ?? 'list')
    : requestedView

  /** 拖曳調整頁籤左右順序。存的是完整順序，不是差異 */
  function reorderTab(activeKey: View, overKey: View) {
    const keys = orderedViews.map(v => v.key)
    const oldIndex = keys.indexOf(activeKey)
    const newIndex = keys.indexOf(overKey)
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return
    setTabOrder(arrayMove(keys, oldIndex, newIndex))
  }

  const { data: project } = useQuery({
    queryKey: ['project', projectId], queryFn: () => Api.project(projectId),
  })
  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', projectId], queryFn: () => Api.tasks(projectId),
  })
  const tasks = tasksData?.tasks ?? []

  // 選了大項目 → 主視圖只顯示它和它底下的小項目（含更深的層）
  const visible = useMemo(() => {
    if (!epicId) return tasks
    const kids = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.parentId) continue
      const a = kids.get(t.parentId) ?? []; a.push(t); kids.set(t.parentId, a)
    }
    const out: Task[] = []
    const seen = new Set<string>()
    const walk = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const self = tasks.find(t => t.id === id)
      if (self) out.push(self)
      for (const k of kids.get(id) ?? []) walk(k.id)
    }
    walk(epicId)
    return out
  }, [tasks, epicId])

  const epic = epicId ? tasks.find(t => t.id === epicId) : undefined

  const overdue = visible.filter(t => t.inquiryState === 'OVERDUE').length

  return (
    <div className="flex h-full">
      <EpicSidebar
        project={project}
        tasks={tasks}
        types={project?.types ?? []}
        selectedEpicId={epicId}
        onSelectEpic={id => {
          setEpicId(id)
          setOpenTask(null)                    // 回到總覽
          if (NOT_FILTERED_BY_EPIC.includes(view)) setView('list')
        }}
        selectedTaskId={openTask}
        onOpenTask={id => {
          setOpenTask(id)
          if (NOT_FILTERED_BY_EPIC.includes(view)) setView('list')
        }}
        onSwitchProject={onSwitchProject}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {openTask ? (
          /* 看單張任務時，上面只留一條麵包屑，把版面讓給內容 */
          <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5
                             text-sm dark:border-slate-700 dark:bg-slate-900">
            <button onClick={() => setOpenTask(null)}
                    className="text-slate-400 hover:text-slate-700
                               dark:text-slate-400 dark:hover:text-slate-300">
              ← {T.nav.backToOverview}
            </button>
            <span className="text-slate-300 dark:text-slate-500">|</span>
            <button onClick={() => { setEpicId(null); setOpenTask(null) }}
                    className="text-slate-400 hover:text-slate-700
                               dark:text-slate-400 dark:hover:text-slate-300">{project?.name}</button>
            {(() => {
              const t = tasks.find(x => x.id === openTask)
              const parent = t?.parentId ? tasks.find(x => x.id === t.parentId) : undefined
              return parent ? (
                <>
                  <span className="text-slate-300 dark:text-slate-500">/</span>
                  <button onClick={() => { setEpicId(parent.id); setOpenTask(null) }}
                          className="text-slate-400 hover:text-slate-700
                                     dark:text-slate-400 dark:hover:text-slate-300">{parent.title}</button>
                </>
              ) : null
            })()}
            <span className="text-slate-300 dark:text-slate-500">/</span>
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {tasks.find(x => x.id === openTask)?.title ?? T.nav.fallbackTaskTitle}
            </span>
            <div className="ml-auto flex items-center gap-2">{bell}{menu}</div>
          </header>
        ) : (
        <header className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-3 px-4 pt-3">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500
                             dark:bg-slate-800 dark:text-slate-400">
              {project?.key}
            </span>
            {epic ? (
              <>
                <button onClick={() => setEpicId(null)}
                        className="text-sm text-slate-400 hover:text-slate-600
                                   dark:text-slate-400 dark:hover:text-slate-300">
                  {project?.name}
                </button>
                <span className="text-slate-300 dark:text-slate-500">/</span>
                <h1 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                  {epic.title}
                </h1>
              </>
            ) : (
              <h1 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {project?.name ?? T.common.none}
              </h1>
            )}
            {overdue > 0 && (
              <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700
                               dark:bg-red-500/15 dark:text-red-300">
                ⚠️ {T.nav.overdueHere(overdue)}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">{bell}{menu}</div>
          </div>
          <nav className="flex items-center gap-1 px-3 pt-2">
            {shownViews.map(v => (
              <button key={v.key} onClick={() => { setView(v.key); setOpenTask(null) }}
                      className={cx(
                        'flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm font-medium',
                        'transition-colors',
                        view === v.key
                          ? 'border-b-2 border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                      )}>
                {v.label}
              </button>
            ))}
            <TabPrefs hidden={hiddenTabs} setHidden={setHiddenTabs}
                      ordered={orderedViews} onReorder={reorderTab}
                      onResetOrder={() => setTabOrder([])}
                      view={view} setView={setView} />
          </nav>
        </header>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {isLoading ? <Spinner /> : openTask ? (
            // 主從式：左邊選了任務，右邊就是那張任務的詳情
            <TaskDrawer
              key={openTask}
              taskId={openTask}
              workspaceId={workspaceId}
              statuses={project?.statuses ?? []}
              allTasks={tasks}
              flash={flashTask === openTask}
              onSeen={onFlashSeen}
              onClose={() => { onFlashSeen(); setOpenTask(null) }}
            />
          ) : (
            <>
              {view === 'list' && (
                <ListView projectId={projectId} tasks={visible} parentForNew={epicId}
                          statuses={project?.statuses ?? []} onOpen={setOpenTask} />
              )}
              {view === 'board' && (
                <Board projectId={projectId} tasks={visible}
                       statuses={project?.statuses ?? []} onOpen={setOpenTask} />
              )}
              {view === 'week' && (
                <WeekView projectId={projectId} tasks={visible}
                          statuses={project?.statuses ?? []} types={project?.types ?? []}
                          onOpen={setOpenTask} />
              )}
              {view === 'calendar' && (
                <CalendarView projectId={projectId} workspaceId={workspaceId}
                              tasks={visible} statuses={project?.statuses ?? []}
                              onOpen={setOpenTask} />
              )}
              {view === 'gantt' && (
                <Suspense fallback={<Spinner label={T.nav.loadingGantt} />}>
                  <GanttView projectId={projectId} tasks={visible} onOpen={setOpenTask} />
                </Suspense>
              )}
              {view === 'graph' && (
                <Suspense fallback={<Spinner label={T.nav.loadingGraph} />}>
                  <GraphView projectId={projectId} tasks={visible}
                             statuses={project?.statuses ?? []} onOpen={setOpenTask} />
                </Suspense>
              )}
              {/*
                * 刻意不傳 visible：燃盡圖與熱圖是整個專案的走勢，後端一次算完。
                * 跟著側欄選的大項目變的話，看到的數字會跟他嘴上說的「專案進度」對不起來。
                */}
              {view === 'dashboard' && (
                <Suspense fallback={<Spinner label={T.nav.loadingDashboard} />}>
                  <DashboardView projectId={projectId} onOpenTask={setOpenTask} />
                </Suspense>
              )}
              {view === 'inquiry' && (
                <InquiryBoard projectId={projectId} workspaceId={workspaceId}
                              onOpenTask={setOpenTask} />
              )}
              {/* 頁籤上的成員頁：看人手上有什麼、以前經手過什麼 */}
              {view === 'members' && (
                <MembersView projectId={projectId} workspaceId={workspaceId}
                             onOpenTask={setOpenTask} />
              )}
              {/* 頭像選單進來的成員管理：改角色、核准加入申請 */}
              {view === 'memberAdmin' && (
                <MembersPanel projectId={projectId} workspaceId={workspaceId} />
              )}
              {view === 'settings' && <ProjectSettings projectId={projectId} />}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
