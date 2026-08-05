import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type LinkType, type Task, type TaskStatus } from '../lib/api'
import { LINK_LABEL, LINK_CHIP, SCHEDULING, SEMANTIC, linkSentence } from '../lib/linkText'
import { Button, Input, Select, Field, Spinner, InquiryBadge, cx } from './ui'
import { InquiryTable } from './InquiryTable'
import { useAuth } from '../lib/auth'
import { T } from '../strings'
import { typesAllowedFor } from '../lib/hierarchy'

/**
 * 任務詳情。
 *
 * variant='pane'（預設）：內嵌在右側主區，左邊選了哪張就顯示哪張——主從式版面。
 * variant='overlay'：舊的覆蓋式抽屜，保留給之後可能需要的浮動情境。
 */
export function TaskDrawer({
  taskId, workspaceId, statuses, allTasks, onClose, variant = 'pane', flash = false, onSeen,
}: {
  taskId: string
  workspaceId: string
  statuses: TaskStatus[]
  allTasks: Task[]
  onClose: () => void
  variant?: 'pane' | 'overlay'
  /**
   * 從通知點進來的就閃一下紅框，指出「就是這一張」——
   * 那一下畫面上換掉太多東西，眼睛不知道該看哪裡。
   * 動畫在 `index.css` 的 `.pmflow-flash`，閃三下之後**紅框留著不會自己消失**。
   */
  flash?: boolean
  /**
   * 他在這張任務上動了一下（點、按鍵）就通知上層把紅框收走 ——
   * 到那一刻才確定他真的看到了。不設時器自動收：人不見得正看著螢幕。
   */
  onSeen?: () => void
}) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['task', taskId], queryFn: () => Api.task(taskId) })
  const [linkError, setLinkError] = useState<string | null>(null)

  /*
   * 我在這個專案是什麼角色。跟 App 那一層用同一組 queryKey 與同一支查詢，
   * 所以這裡讀到的是快取，不會多打一次 API。
   *
   * 後端的規則（apps/api/src/routes/tasks.ts）：
   *   改任務內容  → 要編輯者以上，而且還要是開這張任務的人；專案管理者一律放行
   *   建立／移除關聯 → 兩端都要編輯者，但跟「誰開的」無關（routes/links.ts）
   *   目前遇到的問題、登錄對外詢問的回覆 → 專案成員都可以，所以永遠留著
   */
  const { user } = useAuth()
  const { data: project } = useQuery({
    queryKey: ['project', data?.projectId ?? ''],
    queryFn: () => Api.project(data!.projectId),
    enabled: !!data?.projectId,
  })

  /**
   * 類型與優先度的中文是**這個專案自己定的**（見 0011_project_parameters.sql），
   * 不再是寫死的四種。查不到就退回原始值 —— 那代表清單被改過而任務還指著舊值，
   * 顯示代碼總比顯示空白好，至少看得出來是哪裡對不上。
   */
  const priorities = project?.priorities ?? []
  const priorityOf = (key: string) => priorities.find(p => p.key === key)?.name ?? key
  const types = project?.types ?? []
  const typeOf = (key: string) => types.find(t => t.key === key)?.name ?? ''
  /*
   * 我的角色要從成員名單裡撈自己那一列 —— GET /projects/:id 只回成員名單，
   * 沒有「我是什麼角色」這個欄位（回那個欄位的是專案清單 GET /projects）。
   */
  const role = project?.members.find(m => m.id === user?.id)?.role
  // 專案建立者在建立專案時就拿到 MANAGER，所以判斷一律看角色，不另外看是不是建立者
  const isManager = role === 'MANAGER'
  const canEditLinks = isManager || role === 'EDITOR'
  const canEdit = isManager
    || (canEditLinks && !!user && !!data && data.createdById === user.id)

  // Esc 關閉抽屜。在輸入框裡按 Esc 不關，免得打到一半誤觸把內容弄丟。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (variant !== 'overlay') return
      if (e.key !== 'Escape') return
      const el = document.activeElement
      const typing = el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
         el.isContentEditable)
      if (typing) { (el as HTMLElement).blur(); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, variant])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] })
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['schedule'] })
    // 關聯圖是另一支查詢，節點上也掛著任務的標記（例如「有問題」），
    // 不一起失效的話，改完切過去看到的還是舊的那一張圖
    qc.invalidateQueries({ queryKey: ['graph'] })
  }
  const patch = useMutation({
    mutationFn: (v: Record<string, unknown>) => Api.patchTask(taskId, v), onSuccess: invalidate,
  })
  const addLink = useMutation({
    mutationFn: (v: { targetId: string; linkType: LinkType; lagDays: number }) => Api.addLink(taskId, v),
    onSuccess: () => { setLinkError(null); invalidate() },
    onError: (e: unknown) => setLinkError(
      e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : T.task.link.addFailed),
  })
  const delLink = useMutation({ mutationFn: (id: string) => Api.deleteLink(id), onSuccess: invalidate })

  /*
   * 轉派走專屬的端點，不走 patch —— 換人是欄位，交接說明是話，
   * 兩者要一起寫進同一筆活動紀錄（理由見 api 的 routes/tasks.ts）。
   *
   * reassignTo：正在轉派給誰。null＝沒有在轉派；''＝要收回、不指派給任何人。
   * 選了人先停在這裡，按下「確認轉派」才真的送出 —— 中間那一步就是留給
   * 交接說明的，改完馬上送出的話那句話永遠沒有地方寫。
   */
  const [reassignTo, setReassignTo] = useState<string | null>(null)
  const [handoverNote, setHandoverNote] = useState('')
  const closeReassign = () => { setReassignTo(null); setHandoverNote('') }
  const reassign = useMutation({
    mutationFn: (v: { assigneeId: string | null; note?: string }) => Api.reassignTask(taskId, v),
    onSuccess: () => { closeReassign(); invalidate() },
  })

  const members = project?.members ?? []
  /* 現任負責人被移出專案之後，成員名單裡就沒有他了。不補一項回去的話，
     下拉會顯示成名單上的第一個人，看起來像被誰偷偷換掉 */
  const assigneeOptions = data?.assigneeId && !members.some(m => m.id === data.assigneeId)
    ? [...members,
       { id: data.assigneeId, role: '',
         displayName: T.task.reassign.optionFormerMember(data.assigneeName ?? '') }]
    : members
  const nameOf = (id: string) => members.find(m => m.id === id)?.displayName ?? ''

  /*
   * 種類的下拉要濾掉放不進去的選項。上層與子任務都從 allTasks 找 ——
   * `data.children` 只有 id／標題／狀態，沒有種類。
   */
  const typeChoices = typesAllowedFor(types, {
    current: data?.type ?? '',
    parentType: allTasks.find(t => t.id === data?.parentId)?.type ?? null,
    childTypes: allTasks.filter(t => t.parentId === data?.id).map(t => t.type),
  })

  const [targetId, setTargetId] = useState('')
  const [linkType, setLinkType] = useState<LinkType>('FS')
  const [lag, setLag] = useState(0)

  /*
   * 大項目與任務之間沒有先後（規矩見 AGENTS.md）：一邊是大項目、另一邊不是的時候，
   * 排程那四種整組不給選。兩邊都是大項目、或兩邊都不是，都照舊。
   * 還沒選對象時先當作可以 —— 一進來就少半組選項，看起來像壞掉。
   */
  const targetType = allTasks.find(t => t.id === targetId)?.type
  const schedulingAllowed = !targetType
    || (data?.type === 'EPIC') === (targetType === 'EPIC')

  /*
   * 選了大項目之後，原本停在「完成後開始」的話會變成一個已經不在清單裡的值 ——
   * 畫面顯示第一個語意類，送出去的卻還是排程類。把它拉回合法的第一個。
   */
  useEffect(() => {
    if (!schedulingAllowed && SCHEDULING.includes(linkType)) setLinkType(SEMANTIC[0])
  }, [schedulingAllowed, linkType])

  /*
   * 紅框在他動一下之後收走。用 capture 掛在最外層：底下的控制項各自
   * 有自己的 handler，不 capture 的話點在按鈕上就傳不上來。
   * 沒在閃的時候不掛，省得每一次點擊都跑一趟沒有作用的 setState。
   */
  const seen = flash && onSeen
    ? { onPointerDownCapture: onSeen, onKeyDownCapture: onSeen }
    : {}

  const Shell = ({ children }: { children: React.ReactNode }) =>
    variant === 'overlay' ? (
      <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20 dark:bg-slate-950/60"
           onClick={onClose}>
        {/* 覆蓋式抽屜是疊在卡片上的浮層，深色底要比卡片再亮一階才分得出層次 */}
        <div className={cx('flex h-full w-full max-w-5xl flex-col bg-white shadow-2xl',
                           'dark:bg-slate-800', flash && 'pmflow-flash')}
             {...seen}
             onClick={e => e.stopPropagation()}>
          {children}
        </div>
      </div>
    ) : (
      <div className={cx('flex h-full min-h-0 flex-col bg-white dark:bg-slate-900',
                         flash && 'pmflow-flash')}
           {...seen}>
        {children}
      </div>
    )

  return (
    <Shell>
      <>
        {isLoading || !data ? <Spinner /> : (
          <>
            <header className="flex items-start justify-between border-b border-slate-200 px-6 py-4
                               dark:border-slate-700">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500
                                   dark:bg-slate-800 dark:text-slate-400">
                    {data.ref}
                  </span>
                  <InquiryBadge state={data.inquiryState} />
                  {/* 顏色是那一種種類自己的（系統參數頁裡挑的），不是寫死的紫色；
                      只畫成左邊那條細槓，理由見 pages/List.tsx 同一段註解 */}
                  {typeOf(data.type) && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded
                                     bg-slate-100 py-0.5 pr-1.5 pl-1 text-[11px] text-slate-600
                                     dark:bg-slate-800 dark:text-slate-300">
                      <span className="h-3 w-0.5 rounded-full"
                            style={{ background: types.find(t => t.key === data.type)?.color
                                                 ?? '#94a3b8' }} />
                      {typeOf(data.type)}
                    </span>
                  )}
                </div>
                {canEdit ? (
                  <input
                    defaultValue={data.title}
                    onBlur={e => e.target.value !== data.title && patch.mutate({ title: e.target.value })}
                    className="mt-1.5 w-full border-0 bg-transparent p-0 text-xl font-semibold text-slate-800
                               focus:outline-none focus:ring-0 dark:text-slate-100"
                  />
                ) : (
                  /* 改不動就不要畫成輸入框 —— 看起來能打字卻存不進去最難懂 */
                  <h2 className="mt-1.5 text-xl font-semibold text-slate-800 dark:text-slate-100">
                    {data.title}
                  </h2>
                )}
              </div>
              <Button variant="ghost" onClick={onClose} className="text-lg leading-none">✕</Button>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {/* 欄位都變成純文字之後，總要有一個地方講原因 */}
              {!canEdit && role && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-inset
                                ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300
                                dark:ring-amber-400/30">
                  <p className="font-medium">{T.task.permission.readOnlyTitle}</p>
                  <p className="mt-0.5">{T.task.permission.readOnlyWhy}</p>
                </div>
              )}

              {/*
                * ── 基本欄位 ──
                *
                * 排法有三件事是刻意的：
                * 1. **開始日與結束日一定要落在同一列**。七個欄位塞進四欄的話它們會
                *    被切到兩列去，而那兩個是一起看的 —— 所以放在同一格裡並排。
                * 2. **進度排在日期前面**。回報進度的時候先看的是「做到哪了」，
                *    不是「哪天開始的」。
                * 3. 進度給拖拉條 + 數字兩種輸入。拖拉條快，鍵盤打字準，
                *    只給其中一種一定有人不順手。
                */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label={T.task.drawer.fieldTaskType}>
                  {canEdit ? (
                    /*
                     * 能改成哪幾種，要同時看**上層是誰**與**底下掛了什麼**：
                     * 大項目不能放在任務底下；底下還掛著問題的話，自己就不能
                     * 從任務變成別的（問題的上層一定要是任務）。
                     * 判斷在 lib/hierarchy.ts，後端有同一份守門員。
                     */
                    <Select value={data.type}
                            onChange={e => patch.mutate({ type: e.target.value })}
                            className="w-full">
                      {typeChoices.map(t => (
                        <option key={t.key} value={t.key}>{t.name}</option>
                      ))}
                    </Select>
                  ) : (
                    <ReadOnlyValue>{typeOf(data.type) || data.type}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldStatus}>
                  {canEdit ? (
                    <Select value={data.statusKey}
                            onChange={e => patch.mutate({ statusKey: e.target.value })}
                            className="w-full">
                      {statuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                    </Select>
                  ) : (
                    <ReadOnlyValue>
                      {statuses.find(s => s.key === data.statusKey)?.name ?? T.common.none}
                    </ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldAssignee}>
                  {canEdit ? (
                    /* 選了人不會馬上送出：下面會跳出交接說明，按了才算數 */
                    <Select value={reassignTo ?? (data.assigneeId ?? '')}
                            onChange={e => {
                              const v = e.target.value
                              setHandoverNote('')
                              setReassignTo(v === (data.assigneeId ?? '') ? null : v)
                            }}
                            className="w-full">
                      <option value="">{T.task.reassign.optionUnassigned}</option>
                      {assigneeOptions.map(m => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                    </Select>
                  ) : (
                    <ReadOnlyValue>{data.assigneeName ?? T.common.unassigned}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldPriority}>
                  {canEdit ? (
                    <Select value={data.priority}
                            onChange={e => patch.mutate({ priority: e.target.value })}
                            className="w-full">
                      {priorities.map(p => (
                        <option key={p.key} value={p.key}>{p.name}</option>
                      ))}
                    </Select>
                  ) : (
                    <ReadOnlyValue>{priorityOf(data.priority)}</ReadOnlyValue>
                  )}
                </Field>
                {/* 進度佔兩欄：拖拉條擠在四分之一欄寬裡拖不準 */}
                <div className="col-span-2">
                  <Field label={T.task.drawer.fieldProgress}>
                    {canEdit ? (
                      <ProgressField value={data.progress}
                                     onCommit={v => patch.mutate({ progress: v })} />
                    ) : (
                      <ReadOnlyValue>{T.task.drawer.progressValue(data.progress)}</ReadOnlyValue>
                    )}
                  </Field>
                </div>
                {/* 開始與結束擺在同一格，中間一個破折號 —— 它們是一段期間，不是兩個欄位 */}
                <div className="col-span-2">
                  <Field label={`${T.task.drawer.fieldStart} – ${T.task.drawer.fieldDue}`}>
                    {canEdit ? (
                      <div className="flex items-center gap-2">
                        <Input type="date" className="min-w-0 flex-1"
                               defaultValue={data.startDate?.slice(0, 10) ?? ''}
                               aria-label={T.task.drawer.fieldStart}
                               onBlur={e => patch.mutate({ startDate: e.target.value || null })} />
                        <span aria-hidden className="text-slate-400 dark:text-slate-400">–</span>
                        <Input type="date" className="min-w-0 flex-1"
                               defaultValue={data.dueDate?.slice(0, 10) ?? ''}
                               aria-label={T.task.drawer.fieldDue}
                               onBlur={e => patch.mutate({ dueDate: e.target.value || null })} />
                      </div>
                    ) : (
                      <ReadOnlyValue>
                        {fmtDate(data.startDate)} – {fmtDate(data.dueDate)}
                      </ReadOnlyValue>
                    )}
                  </Field>
                </div>
                <Field label={T.task.drawer.fieldScheduleMode}>
                  {canEdit ? (
                    <Select value={data.scheduleMode}
                            onChange={e => patch.mutate({ scheduleMode: e.target.value })}
                            className="w-full">
                      <option value="AUTO">{T.task.drawer.scheduleAuto}</option>
                      <option value="MANUAL">{T.task.drawer.scheduleManual}</option>
                    </Select>
                  ) : (
                    <ReadOnlyValue>
                      {data.scheduleMode === 'AUTO'
                        ? T.task.drawer.scheduleAuto
                        : T.task.drawer.scheduleManual}
                    </ReadOnlyValue>
                  )}
                </Field>
              </div>

              {/* ── 轉派的交接說明 ──
                  刻意放在基本欄位「下面」而不是塞進那一格：那一格只有四分之一寬，
                  一句交接說明打不了幾個字就看不到開頭 */}
              {canEdit && reassignTo !== null && (
                <div className="rounded-md bg-blue-50 px-3 py-2.5 ring-1 ring-inset ring-blue-600/20
                                dark:bg-blue-500/15 dark:ring-blue-400/30">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                    {reassignTo
                      ? (data.assigneeName
                          ? T.task.reassign.confirmChange(data.assigneeName, nameOf(reassignTo))
                          : T.task.reassign.confirmAssign(nameOf(reassignTo)))
                      : (data.assigneeName
                          ? T.task.reassign.confirmClear(data.assigneeName)
                          : T.task.reassign.confirmClearNobody)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      autoFocus
                      value={handoverNote}
                      onChange={e => setHandoverNote(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !reassign.isPending) {
                          reassign.mutate({ assigneeId: reassignTo || null, note: handoverNote })
                        }
                        if (e.key === 'Escape') closeReassign()
                      }}
                      placeholder={T.task.reassign.notePlaceholder}
                      className="min-w-56 flex-1"
                    />
                    <Button variant="primary" disabled={reassign.isPending}
                            onClick={() => reassign.mutate({
                              assigneeId: reassignTo || null, note: handoverNote,
                            })}>
                      {T.task.reassign.submit}
                    </Button>
                    <Button variant="ghost" onClick={closeReassign}>{T.common.cancel}</Button>
                  </div>
                  <p className="mt-1.5 text-xs text-blue-700 dark:text-blue-200">
                    {T.task.reassign.noteHint}
                  </p>
                </div>
              )}

              {/* ── 目前遇到的問題 ──
                  放在基本欄位下面、對外詢問上面：它比日期進度更要緊，
                  但它常常就是「問出去了還在等回覆」的那個原因，兩者要挨著看 */}
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                    {T.task.problem.label}
                  </h3>
                  {data.problem && (
                    <Button variant="ghost" className="text-xs text-slate-500 dark:text-slate-400"
                            onClick={() => patch.mutate({ problem: null })}>
                      {T.task.problem.clear}
                    </Button>
                  )}
                </div>
                <textarea
                  /* 清空之後輸入框裡的字也要跟著不見。defaultValue 只在掛載時讀一次，
                     換 key 逼它重新掛載 —— 改成受控值的話每打一個字都要重畫整個抽屜 */
                  key={data.problem ?? ''}
                  defaultValue={data.problem ?? ''}
                  rows={2}
                  onBlur={e => {
                    if (e.target.value.trim() === (data.problem ?? '')) return
                    patch.mutate({ problem: e.target.value })
                  }}
                  placeholder={T.task.problem.placeholder}
                  className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm
                             placeholder:text-slate-400 focus:border-blue-500 focus:outline-none
                             focus:ring-2 focus:ring-blue-500/40
                             dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100
                             dark:placeholder:text-slate-500"
                />
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-400">
                  {T.task.problem.hint}
                </p>
              </div>

              {/* ── 對外詢問：核心功能 ──
                  canEdit 一律給 true。登錄回覆後端只要求專案成員，是「誰收到誰登錄」，
                  絕不能因為任務不是自己開的就收起來；而這個元件目前用同一個
                  canEdit 同時管著新增與登錄回覆，收掉就會把回覆一起收掉。
                  要分開得改 InquiryTable，那個檔不在這次可以改的範圍。 */}
              <InquiryTable taskId={taskId} workspaceId={workspaceId}
                            inquiries={data.inquiries} canEdit />

              {/* ── 左右關聯 ── */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                  {T.task.link.title}{' '}
                  <span className="font-normal text-slate-400 dark:text-slate-400">
                    {T.task.link.titleHint}
                  </span>
                </h3>
                <div className="space-y-1.5">
                  {data.links.length === 0 && (
                    <p className="text-sm text-slate-400 dark:text-slate-400">{T.task.link.empty}</p>
                  )}
                  {data.links.map(l => (
                    <div key={l.id + l.direction}
                         className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm
                                    dark:bg-slate-800">
                      <span className={cx(
                        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                        SCHEDULING.includes(l.linkType)
                          ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                          : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                      )}>{LINK_CHIP[l.linkType]}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
                        {linkSentence(l.linkType, l.direction, l.otherRef)}
                        <span className="ml-1.5 text-slate-400 dark:text-slate-400">{l.otherTitle}</span>
                      </span>
                      {l.lagDays !== 0 && (
                        <span className="shrink-0 text-xs text-slate-400 dark:text-slate-400">
                          {T.task.link.lagDays(l.lagDays)}
                        </span>
                      )}
                      {canEditLinks && (
                        <Button variant="ghost" className="text-xs text-slate-400 dark:text-slate-400"
                                onClick={() => delLink.mutate(l.id)}>✕</Button>
                      )}
                    </div>
                  ))}
                </div>

                {!canEditLinks && role && (
                  <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">
                    {T.task.permission.linkReadOnly}
                  </p>
                )}

                {canEditLinks && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-56 flex-1">
                    <Field label={T.task.link.fieldTarget}>
                      <Select value={targetId} onChange={e => setTargetId(e.target.value)}
                              className="w-full">
                        <option value="">{T.task.link.pickTask}</option>
                        {allTasks.filter(t => t.id !== taskId).map(t => (
                          <option key={t.id} value={t.id}>{t.ref} {t.title}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="w-60">
                    <Field label={T.task.link.fieldType}>
                      <Select value={linkType} onChange={e => setLinkType(e.target.value as LinkType)}
                              className="w-full">
                        {/* 大項目與任務之間沒有先後，排程那一組整個不畫（見下方說明） */}
                        {schedulingAllowed && (
                          <optgroup label={T.task.link.groupScheduling}>
                            {SCHEDULING.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                          </optgroup>
                        )}
                        <optgroup label={T.task.link.groupSemantic}>
                          {SEMANTIC.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                      </Select>
                    </Field>
                    {/* 選項少了一整組一定要講原因，不然看起來像壞掉 */}
                    {!schedulingAllowed && (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {T.task.link.noSchedulingAcrossEpic}
                      </p>
                    )}
                  </div>
                  <div className="w-28">
                    <Field label={T.task.link.fieldLag}>
                      <Input type="number" value={lag} onChange={e => setLag(Number(e.target.value))}
                             title={T.task.link.lagHint} />
                    </Field>
                  </div>
                  <Button variant="primary" disabled={!targetId || addLink.isPending}
                          onClick={() => addLink.mutate({ targetId, linkType, lagDays: lag })}>
                    {T.task.link.add}
                  </Button>
                </div>
                )}
                {linkError && (
                  <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200
                                  dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30">
                    {linkError}
                  </div>
                )}
              </div>

              {/* ── 上下階層 ── */}
              {data.children.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                    {T.task.children.title}{' '}
                    <span className="font-normal text-slate-400 dark:text-slate-400">
                      {T.task.children.titleHint}
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {data.children.map(c => (
                      <div key={c.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm
                                                 dark:bg-slate-800 dark:text-slate-200">
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{c.ref}</span>
                        <span className="flex-1 truncate">{c.title}</span>
                        <span className="text-xs text-slate-400 dark:text-slate-400">{c.progress}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── 活動時間軸 ── */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                  {T.task.drawer.activityTitle}
                </h3>
                <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                  {data.activities.slice(0, 15).map(a => (
                    <li key={a.id}>
                      <div className="flex gap-2">
                        <span className="text-slate-400 dark:text-slate-400">
                          {new Date(a.createdAt).toLocaleString('zh-TW')}
                        </span>
                        <span className="text-slate-600 dark:text-slate-300">
                          {a.actorName ?? T.task.drawer.systemActor}
                        </span>
                        <span>{describeActivity(a.kind, a.body)}</span>
                      </div>
                      {/* 交接說明另起一行帶引號 —— 那是一句人講的話，
                          接在「把負責人從誰換成誰」後面會跟事實糊在一起 */}
                      {handoverNoteOf(a.body) && (
                        <p className="mt-0.5 pl-1 text-slate-600 dark:text-slate-300">
                          {T.task.activity.handoverNote(handoverNoteOf(a.body))}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}
      </>
    </Shell>
  )
}

/**
 * 沒有修改權限時，欄位只留值本身。
 * 高度刻意跟輸入框對齊，換一個人看同一張任務時版面不會整個跳掉。
 */
function ReadOnlyValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-0.5 py-1.5 text-sm text-slate-800 dark:text-slate-100">{children}</div>
  )
}

const fmtDate = (d: string | null) =>
  (d ? d.slice(0, 10).replaceAll('-', '/') : T.common.none)

/**
 * 進度：拖拉條 + 數字，兩種都能改。
 *
 * **拖的過程不送出**（`onChange` 只更新本地的數字，`onPointerUp`／`onKeyUp`
 * 才真的存）—— 一路拖過去每一格都打一次 PATCH 的話，一次拖曳會發出上百個請求，
 * 而且回來的順序不保證，畫面會跳。
 *
 * 外面的值變了（例如別的地方改了進度、或存檔失敗被打回）就跟著回正，
 * 但**正在拖的時候不要被蓋掉**，不然手還按著數字就自己跳回去。
 */
function ProgressField({ value, onCommit }: {
  value: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(value)
  const dragging = useRef(false)
  useEffect(() => { if (!dragging.current) setDraft(value) }, [value])

  const commit = (v: number) => {
    dragging.current = false
    const clamped = Math.min(100, Math.max(0, Math.round(v)))
    setDraft(clamped)
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <div className="flex items-center gap-3">
      <input
        type="range" min={0} max={100} step={5} value={draft}
        aria-label={T.task.drawer.progressAria}
        onPointerDown={() => { dragging.current = true }}
        onChange={e => setDraft(Number(e.target.value))}
        onPointerUp={e => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={e => commit(Number((e.target as HTMLInputElement).value))}
        onBlur={() => commit(draft)}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full
                   bg-slate-200 accent-blue-600 dark:bg-slate-700 dark:accent-blue-500"
      />
      {/*
        * 數字也能直接打 —— 要 35% 的時候拖拉條對不準。
        * 寬度掛在外面這層 div，不是掛在 Input 上：`Input` 自己帶 `w-full`，
        * 跟 `w-16` 是同一個 specificity，誰贏要看 CSS 的順序 ——
        * 實際上是 `w-full` 贏，數字框會把拖拉條整條擠掉。
        */}
      <div className="w-16 shrink-0">
        <Input
          type="number" min={0} max={100} value={draft}
          aria-label={T.task.drawer.fieldProgress}
          onChange={e => setDraft(Number(e.target.value))}
          onBlur={e => commit(Number(e.target.value))}
          className="text-right tabular-nums"
        />
      </div>
    </div>
  )
}

/** 這筆活動紀錄有沒有附交接說明（只有轉派會有）。沒有就回空字串 */
function handoverNoteOf(body: Record<string, unknown> | null): string {
  return body?.reassign && body.note ? String(body.note) : ''
}

function describeActivity(kind: string, body: Record<string, unknown> | null): string {
  switch (kind) {
    case 'CREATED': return T.task.activity.created
    case 'COMMENT': return T.task.activity.comment(String(body?.text ?? ''))
    case 'LINK_CHANGE': {
      const t = String(body?.linkType ?? '') as LinkType
      return T.task.activity.linkChange(LINK_CHIP[t] ?? t)
    }
    case 'INQUIRY_CHANGE':
      return body?.action === 'ask'
        ? T.task.activity.inquiryAsk(String(body?.unit ?? ''))
        : T.task.activity.inquiryReply(body?.repliedByUnit ? String(body.repliedByUnit) : '')
    default:
      /*
       * 轉派也是 FIELD_CHANGE（負責人就是任務的一個欄位），靠 body 的
       * reassign 認出來。四種情形各自成一句：沒有原負責人、收回不指派時
       * 用同一句去填空的話，會拼出「把負責人從 （空白） 換成」。
       */
      if (body?.reassign) {
        const from = body.previousAssigneeName ? String(body.previousAssigneeName) : ''
        const to = body.assigneeName ? String(body.assigneeName) : ''
        if (to) return from ? T.task.activity.reassigned(from, to) : T.task.activity.assigned(to)
        return from ? T.task.activity.unassignedFrom(from) : T.task.activity.unassignedNobody
      }
      /*
       * 問題被清空之後，任務上就沒有它了 —— 這一行是唯一查得回「當初卡在哪」
       * 的地方，所以把清掉之前那段字一起寫出來，而不是只說「更新了欄位」。
       */
      if (body && 'problem' in body) {
        const before = body.problemBefore ? String(body.problemBefore) : ''
        return body.problem
          ? T.task.activity.problemSet(String(body.problem))
          : T.task.activity.problemCleared(before)
      }
      return T.task.activity.fieldUpdated
  }
}
