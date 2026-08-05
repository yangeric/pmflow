import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api, type AppNotification, type Task, type WorkspaceRole } from './lib/api'
import { useAuth } from './lib/auth'
import { T } from './strings'
import { Button, Spinner, cx } from './components/ui'
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
import ProjectSettings from './components/ProjectSettings'
import AccountPanel from './components/AccountPanel'
import AdminPanel from './components/AdminPanel'
import WeekView from './pages/Week'
// 儀表板一進去就要打兩支要算的 API，圖表本身也只有這一頁用得到，
// 跟甘特、關聯圖一樣延後載入
const DashboardView = lazy(() => import('./pages/Dashboard'))

type View = 'list' | 'board' | 'week' | 'calendar' | 'gantt' | 'graph' | 'dashboard'
  | 'inquiry' | 'members' | 'settings'

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
  // 成員刻意不放在這一排。這排是「同一批任務的不同看法」，
  // 成員是專案的設定，混在裡面會讓人以為它也是一種任務視圖。入口在右上角的頭像選單。
]

/**
 * 這幾個畫面不吃側欄「大項目」那個篩選 —— 發文追蹤與成員本來就跟大項目無關，
 * 儀表板則是整個專案一起算的。停在這些畫面上點大項目，按下去會沒有任何反應，
 * 所以一律先回清單。
 */
const NOT_FILTERED_BY_EPIC: View[] = ['inquiry', 'members', 'settings', 'dashboard']

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
    // 有人來敲門要在「成員」頁籤才處理得了；其他都回到任務清單
    setView(n.kind === 'JOIN_REQUESTED' ? 'members' : 'list')
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
        ? () => { setAccount(null); setView('members'); setOpenTask(null) }
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

/**
 * 有選定專案時的主畫面：左側大項目、右側視圖。
 * 查詢集中在這一層，側欄和主視圖吃同一份資料，不會各抓一次。
 */
function ProjectWorkspace({
  projectId, workspaceId, view, setView, openTask, setOpenTask, flashTask, onFlashSeen,
  onSwitchProject, bell, menu,
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
                <button onClick={() => setEpicId(null)}
                        className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500
                                   hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400
                                   dark:hover:bg-slate-700">
                  ✕ {T.nav.showAll}
                </button>
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
          <nav className="flex gap-1 px-3 pt-2">
            {VIEWS.map(v => (
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
              {view === 'members' && (
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
