import { lazy, Suspense, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Task } from './lib/api'
import { useAuth } from './lib/auth'
import { Button, Input, Spinner, cx } from './components/ui'
import { TaskDrawer } from './components/TaskDrawer'
import { EpicSidebar } from './components/EpicSidebar'
import Login from './pages/Login'
import Board from './pages/Board'
import ListView from './pages/List'
// dhtmlx-gantt 有 700KB+，只在真的切到甘特頁時才載入，
// 不要讓只想看看板的人也付這個代價
const GanttView = lazy(() => import('./pages/Gantt'))
import CalendarView from './pages/Calendar'
import InquiryBoard from './pages/InquiryBoard'
import ProjectPicker from './pages/ProjectPicker'

type View = 'list' | 'board' | 'calendar' | 'gantt' | 'inquiry'

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'list', label: '清單' },
  { key: 'board', label: '看板' },
  { key: 'calendar', label: '行事曆' },
  { key: 'gantt', label: '甘特圖' },
]

export default function App() {
  const { user, workspaces, ready, logout } = useAuth()
  // projectId 為 null＝還沒選專案，顯示選擇頁。
  // 專案切換刻意只發生在這一層，側欄不再放專案清單。
  const [projectId, setProjectId] = useState<string | null>(null)
  const [view, setView] = useState<View>('list')
  const [openTask, setOpenTask] = useState<string | null>(null)

  const { data: projectsData } = useQuery({
    queryKey: ['projects'], queryFn: Api.projects, enabled: !!user,
  })
  const projects = projectsData?.projects ?? []

  if (!ready) return <Spinner label="啟動中…" />
  if (!user) return <Login />

  const workspaceId = workspaces[0]?.id ?? projects[0]?.workspaceId ?? ''
  const totalOverdue = projects.reduce((n, p) => n + (p.overdueInquiryCount ?? 0), 0)

  // ── 還沒選專案 → 選擇頁 ──
  if (!projectId && view !== 'inquiry') {
    return (
      <ProjectPicker
        projects={projects}
        workspaceId={workspaceId}
        userName={user.displayName}
        onPick={id => { setProjectId(id); setView('list') }}
        onInquiryBoard={() => setView('inquiry')}
        onLogout={logout}
      />
    )
  }

  // ── 從選擇頁點進發文追蹤（跨專案，沒有側欄）──
  if (!projectId) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
          <Button variant="ghost" onClick={() => setView('list')}>← 回專案選擇</Button>
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
      userName={user.displayName}
      onLogout={logout}
      onSwitchProject={() => { setProjectId(null); setView('list'); setOpenTask(null) }}
    />
  )
}

/**
 * 有選定專案時的主畫面：左側大項目、右側視圖。
 * 查詢集中在這一層，側欄和主視圖吃同一份資料，不會各抓一次。
 */
function ProjectWorkspace({
  projectId, workspaceId, view, setView, openTask, setOpenTask,
  totalOverdue, userName, onLogout, onSwitchProject,
}: {
  projectId: string
  workspaceId: string
  view: View
  setView: (v: View) => void
  openTask: string | null
  setOpenTask: (id: string | null) => void
  totalOverdue: number
  userName: string
  onLogout: () => void
  onSwitchProject: () => void
}) {
  const qc = useQueryClient()
  const [newTitle, setNewTitle] = useState('')
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

  const create = useMutation({
    // 篩在某個大項目底下時，新任務直接掛進去，不用再手動搬
    mutationFn: (title: string) =>
      Api.createTask(projectId, epicId ? { title, parentId: epicId } : { title }),
    onSuccess: () => {
      setNewTitle('')
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

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
        overdueTotal={totalOverdue}
        userName={userName}
        onLogout={onLogout}
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
                <div className="ml-auto flex items-center gap-2">
                  <Input
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newTitle.trim()) create.mutate(newTitle.trim())
                    }}
                    placeholder={epic ? `新增到「${epic.title}」底下` : '輸入標題後按 Enter 新增任務'}
                    className="w-64"
                  />
                  <Button variant="primary" disabled={!newTitle.trim() || create.isPending}
                          onClick={() => create.mutate(newTitle.trim())}>＋ 新增任務</Button>
                </div>
              </div>
              <nav className="flex gap-1 px-3 pt-2">
                {VIEWS.map(v => (
                  <button key={v.key} onClick={() => { setView(v.key); setOpenTask(null) }}
                          className={cx(
                            'rounded-t-md px-3 py-1.5 text-sm font-medium transition-colors',
                            view === v.key
                              ? 'border-b-2 border-blue-600 text-blue-700'
                              : 'text-slate-500 hover:text-slate-700'
                          )}>{v.label}</button>
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
                    <ListView tasks={visible} statuses={project?.statuses ?? []} onOpen={setOpenTask} />
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
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
