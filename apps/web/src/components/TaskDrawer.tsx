import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type LinkType, type Task, type TaskStatus } from '../lib/api'
import { LINK_LABEL, LINK_CHIP, SCHEDULING, SEMANTIC, linkSentence } from '../lib/linkText'
import { Button, Input, Select, Field, Spinner, InquiryBadge, cx } from './ui'
import { InquiryTable } from './InquiryTable'
import { useAuth } from '../lib/auth'
import { T } from '../strings'

const TYPE_LABEL: Partial<Record<Task['type'], string>> = T.task.type

const PRIORITY_LABEL = T.task.priority

/**
 * 任務詳情。
 *
 * variant='pane'（預設）：內嵌在右側主區，左邊選了哪張就顯示哪張——主從式版面。
 * variant='overlay'：舊的覆蓋式抽屜，保留給之後可能需要的浮動情境。
 */
export function TaskDrawer({
  taskId, workspaceId, statuses, allTasks, onClose, variant = 'pane',
}: {
  taskId: string
  workspaceId: string
  statuses: TaskStatus[]
  allTasks: Task[]
  onClose: () => void
  variant?: 'pane' | 'overlay'
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
   *   目前遇到的問題、登錄發文追蹤的回覆 → 專案成員都可以，所以永遠留著
   */
  const { user } = useAuth()
  const { data: project } = useQuery({
    queryKey: ['project', data?.projectId ?? ''],
    queryFn: () => Api.project(data!.projectId),
    enabled: !!data?.projectId,
  })
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

  const [targetId, setTargetId] = useState('')
  const [linkType, setLinkType] = useState<LinkType>('FS')
  const [lag, setLag] = useState(0)

  const Shell = ({ children }: { children: React.ReactNode }) =>
    variant === 'overlay' ? (
      <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20 dark:bg-slate-950/60"
           onClick={onClose}>
        {/* 覆蓋式抽屜是疊在卡片上的浮層，深色底要比卡片再亮一階才分得出層次 */}
        <div className="flex h-full w-full max-w-5xl flex-col bg-white shadow-2xl dark:bg-slate-800"
             onClick={e => e.stopPropagation()}>
          {children}
        </div>
      </div>
    ) : (
      <div className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-900">{children}</div>
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
                  {TYPE_LABEL[data.type] && (
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700
                                     dark:bg-violet-500/15 dark:text-violet-300">
                      {TYPE_LABEL[data.type]}
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

              {/* ── 基本欄位 ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                <Field label={T.task.drawer.fieldPriority}>
                  {canEdit ? (
                    <Select value={data.priority}
                            onChange={e => patch.mutate({ priority: e.target.value })}
                            className="w-full">
                      {(Object.keys(PRIORITY_LABEL) as Array<keyof typeof PRIORITY_LABEL>)
                        .map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                    </Select>
                  ) : (
                    <ReadOnlyValue>{PRIORITY_LABEL[data.priority]}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldStart}>
                  {canEdit ? (
                    <Input type="date" defaultValue={data.startDate?.slice(0, 10) ?? ''}
                           onBlur={e => patch.mutate({ startDate: e.target.value || null })} />
                  ) : (
                    <ReadOnlyValue>{fmtDate(data.startDate)}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldDue}>
                  {canEdit ? (
                    <Input type="date" defaultValue={data.dueDate?.slice(0, 10) ?? ''}
                           onBlur={e => patch.mutate({ dueDate: e.target.value || null })} />
                  ) : (
                    <ReadOnlyValue>{fmtDate(data.dueDate)}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldProgress}>
                  {canEdit ? (
                    <Input type="number" min={0} max={100} defaultValue={data.progress}
                           onBlur={e => patch.mutate({ progress: Number(e.target.value) })} />
                  ) : (
                    <ReadOnlyValue>{data.progress}</ReadOnlyValue>
                  )}
                </Field>
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

              {/* ── 目前遇到的問題 ──
                  放在基本欄位下面、發文追蹤上面：它比日期進度更要緊，
                  但它常常就是「發文出去在等回覆」的那個原因，兩者要挨著看 */}
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

              {/* ── 發文追蹤：核心功能 ──
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
                        <optgroup label={T.task.link.groupScheduling}>
                          {SCHEDULING.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                        <optgroup label={T.task.link.groupSemantic}>
                          {SEMANTIC.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                      </Select>
                    </Field>
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
                    <li key={a.id} className="flex gap-2">
                      <span className="text-slate-400 dark:text-slate-400">
                        {new Date(a.createdAt).toLocaleString('zh-TW')}
                      </span>
                      <span className="text-slate-600 dark:text-slate-300">
                        {a.actorName ?? T.task.drawer.systemActor}
                      </span>
                      <span>{describeActivity(a.kind, a.body)}</span>
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
