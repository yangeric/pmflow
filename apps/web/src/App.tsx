import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api, type AppNotification, type Task, type WorkspaceRole } from './lib/api'
import { useAuth } from './lib/auth'
import { Button, Spinner, cx } from './components/ui'
import { TaskDrawer } from './components/TaskDrawer'
import { EpicSidebar } from './components/EpicSidebar'
import { NotificationBell } from './components/NotificationBell'
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
import AccountPanel from './components/AccountPanel'
import AdminPanel from './components/AdminPanel'

type View = 'list' | 'board' | 'calendar' | 'gantt' | 'graph' | 'inquiry' | 'members'

/**
 * 帳號設定與系統管理不是專案底下的視圖 —— 沒選專案也要進得去，
 * 所以獨立成一層蓋在最上面，離開就回到原本看到的畫面。
 */
type AccountView = 'profile' | 'admin' | null

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'list', label: '清單' },
  { key: 'board', label: '看板' },
  { key: 'calendar', label: '行事曆' },
  { key: 'gantt', label: '甘特圖' },
  { key: 'graph', label: '關聯圖' },
  // 成員刻意不放在這一排。這排是「同一批任務的不同看法」，
  // 成員是專案的設定，混在裡面會讓人以為它也是一種任務視圖。入口移到側欄。
]

export default function App() {
  const { user, workspaces, ready, logout } = useAuth()
  // projectId 為 null＝還沒選專案，顯示選擇頁。
  // 專案切換刻意只發生在這一層，側欄不再放專案清單。
  const [projectId, setProjectId] = useState<string | null>(null)
  const [view, setView] = useState<View>('list')
  const [openTask, setOpenTask] = useState<string | null>(null)
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

  if (!ready) return <Spinner label="啟動中…" />
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
    // 有人來敲門要在「成員」頁籤才處理得了；其他都回到任務清單
    setView(n.kind === 'JOIN_REQUESTED' ? 'members' : 'list')
  }
  const bell = <NotificationBell onOpen={openNotification} />

  const workspaceId = workspaces[0]?.id ?? projects[0]?.workspaceId ?? ''
  const totalOverdue = projects.reduce((n, p) => n + (p.overdueInquiryCount ?? 0), 0)
  // 「系統管理」只給工作區的擁有者與管理者看到。後端也會再擋一次，
  // 這裡收起來只是不要讓人按了才被拒絕
  const isWorkspaceAdmin = ['OWNER', 'ADMIN'].includes(workspaces[0]?.role ?? '')

  // ── 帳號設定／系統管理：蓋在最上面，離開就回到原本的畫面 ──
  if (account) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 border-b border-slate-200 bg-white px-4 py-2.5">
          <Button variant="ghost" onClick={() => setAccount(null)}>← 返回</Button>
          <span className="mx-2 text-slate-200">|</span>
          <AccountTab active={account === 'profile'}
                      onClick={() => setAccount('profile')}>帳號設定</AccountTab>
          {isWorkspaceAdmin && (
            <AccountTab active={account === 'admin'}
                        onClick={() => setAccount('admin')}>系統管理</AccountTab>
          )}
          <div className="ml-auto">{bell}</div>
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
  if (!projectId && view !== 'inquiry') {
    return (
      <ProjectPicker
        projects={projects}
        workspaceId={workspaceId}
        userName={user.displayName}
        onPick={id => { setProjectId(id); setView('list') }}
        onInquiryBoard={() => setView('inquiry')}
        onAccount={() => setAccount('profile')}
        onLogout={logout}
        bell={bell}
      />
    )
  }

  // ── 從選擇頁點進發文追蹤（跨專案，沒有側欄）──
  if (!projectId) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
          <Button variant="ghost" onClick={() => setView('list')}>← 回專案選擇</Button>
          <div className="ml-auto">{bell}</div>
        </header>
        <div className="min-h-0 flex-1">
          <InquiryBoard
            workspaceId={workspaceId}
            onOpenTask={(pid, tid) => { setProjectId(pid); setView('list'); setOpenTask(tid) }}
          />
        </div>
      </div>
    )
  }

  return (
    <ProjectWorkspace
      key={projectId}
      projectId={projectId}
      workspaceId={workspaceId}
      view={view} setView={setView}
      openTask={openTask} setOpenTask={setOpenTask}
      totalOverdue={totalOverdue}
      pendingJoins={projects.find(p => p.id === projectId)?.pendingJoinRequestCount ?? 0}
      userName={user.displayName}
      onLogout={logout}
      onAccount={() => setAccount('profile')}
      onSwitchProject={() => { setProjectId(null); setView('list'); setOpenTask(null) }}
      bell={<NotificationBell onOpen={openNotification} placement="up" />}
    />
  )
}

function AccountTab({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: ReactNode
}) {
  return (
    <button onClick={onClick}
            className={cx('rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          active ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:text-slate-700')}>
      {children}
    </button>
  )
}

/**
 * 有選定專案時的主畫面：左側大項目、右側視圖。
 * 查詢集中在這一層，側欄和主視圖吃同一份資料，不會各抓一次。
 */
function ProjectWorkspace({
  projectId, workspaceId, view, setView, openTask, setOpenTask,
  totalOverdue, pendingJoins, userName, onLogout, onAccount, onSwitchProject, bell,
}: {
  projectId: string
  workspaceId: string
  view: View
  setView: (v: View) => void
  openTask: string | null
  setOpenTask: (id: string | null) => void
  totalOverdue: number
  /** 待審的加入申請數。不是建立者的話後端一律回 0 */
  pendingJoins: number
  userName: string
  onLogout: () => void
  onAccount: () => void
  onSwitchProject: () => void
  /** 通知鈴鐺。由 App 建立，因為點下去要跳去哪是 App 的導覽狀態 */
  bell: ReactNode
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
          if (view === 'inquiry') setView('list')
        }}
        selectedTaskId={openTask}
        onOpenTask={id => { setOpenTask(id); if (view === 'inquiry') setView('list') }}
        onSwitchProject={onSwitchProject}
        onInquiryBoard={() => setView('inquiry')}
        inquiryActive={view === 'inquiry'}
        onMembers={() => { setView('members'); setOpenTask(null) }}
        membersActive={view === 'members'}
        pendingJoins={pendingJoins}
        overdueTotal={totalOverdue}
        userName={userName}
        onLogout={onLogout}
        onAccount={onAccount}
        bell={bell}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {view === 'inquiry' ? (
          <>
            <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
              <Button variant="ghost" onClick={() => setView('list')}>← 回專案</Button>
            </header>
            <div className="min-h-0 flex-1">
              <InquiryBoard
                workspaceId={workspaceId}
                onOpenTask={(_pid, tid) => { setView('list'); setEpicId(null); setOpenTask(tid) }}
              />
            </div>
          </>
        ) : (
          <>
            {openTask ? (
              /* 看單張任務時，上面只留一條麵包屑，把版面讓給內容 */
              <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 text-sm">
                <button onClick={() => setOpenTask(null)}
                        className="text-slate-400 hover:text-slate-700">← 回總覽</button>
                <span className="text-slate-300">|</span>
                <button onClick={() => { setEpicId(null); setOpenTask(null) }}
                        className="text-slate-400 hover:text-slate-700">{project?.name}</button>
                {(() => {
                  const t = tasks.find(x => x.id === openTask)
                  const parent = t?.parentId ? tasks.find(x => x.id === t.parentId) : undefined
                  return parent ? (
                    <>
                      <span className="text-slate-300">/</span>
                      <button onClick={() => { setEpicId(parent.id); setOpenTask(null) }}
                              className="text-slate-400 hover:text-slate-700">{parent.title}</button>
                    </>
                  ) : null
                })()}
                <span className="text-slate-300">/</span>
                <span className="font-medium text-slate-700">
                  {tasks.find(x => x.id === openTask)?.title ?? '任務'}
                </span>
              </header>
            ) : (
            <header className="border-b border-slate-200 bg-white">
              <div className="flex items-center gap-3 px-4 pt-3">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500">
                  {project?.key}
                </span>
                {epic ? (
                  <>
                    <button onClick={() => setEpicId(null)}
                            className="text-sm text-slate-400 hover:text-slate-600">
                      {project?.name}
                    </button>
                    <span className="text-slate-300">/</span>
                    <h1 className="text-base font-semibold text-slate-800">{epic.title}</h1>
                    <button onClick={() => setEpicId(null)}
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500
                                       hover:bg-slate-200">
                      ✕ 看全部
                    </button>
                  </>
                ) : (
                  <h1 className="text-base font-semibold text-slate-800">{project?.name ?? '—'}</h1>
                )}
                {overdue > 0 && (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                    ⚠️ {overdue} 張任務有單位逾期未回
                  </span>
                )}
              </div>
              <nav className="flex gap-1 px-3 pt-2">
                {VIEWS.map(v => (
                  <button key={v.key} onClick={() => { setView(v.key); setOpenTask(null) }}
                          className={cx(
                            'flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm font-medium',
                            'transition-colors',
                            view === v.key
                              ? 'border-b-2 border-blue-600 text-blue-700'
                              : 'text-slate-500 hover:text-slate-700'
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
                  onClose={() => setOpenTask(null)}
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
                  {view === 'calendar' && (
                    <CalendarView projectId={projectId} workspaceId={workspaceId}
                                  tasks={visible} statuses={project?.statuses ?? []}
                                  onOpen={setOpenTask} />
                  )}
                  {view === 'gantt' && (
                    <Suspense fallback={<Spinner label="載入甘特圖…" />}>
                      <GanttView projectId={projectId} tasks={visible} onOpen={setOpenTask} />
                    </Suspense>
                  )}
                  {view === 'graph' && (
                    <Suspense fallback={<Spinner label="載入關聯圖…" />}>
                      <GraphView projectId={projectId} tasks={visible}
                                 statuses={project?.statuses ?? []} onOpen={setOpenTask} />
                    </Suspense>
                  )}
                  {view === 'members' && (
                    <MembersPanel projectId={projectId} workspaceId={workspaceId} />
                  )}
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
