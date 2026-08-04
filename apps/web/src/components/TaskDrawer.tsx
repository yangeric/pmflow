import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type LinkType, type Task, type TaskStatus } from '../lib/api'
import { LINK_LABEL, LINK_CHIP, SCHEDULING, SEMANTIC, linkSentence } from '../lib/linkText'
import { Button, Input, Field, Spinner, InquiryBadge, cx } from './ui'
import { InquiryTable } from './InquiryTable'
import { T } from '../strings'

const TYPE_LABEL: Partial<Record<Task['type'], string>> = T.task.type

const PRIORITY_LABEL = T.task.priority

/**
 * 下拉的樣式。ui.tsx 只包了 Input 沒包 select，這一頁有五個下拉，
 * 各自寫一份的話深色配色一定會漏掉其中一個。
 */
const SELECT_CLS = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm '
  + 'text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'

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
                <input
                  defaultValue={data.title}
                  onBlur={e => e.target.value !== data.title && patch.mutate({ title: e.target.value })}
                  className="mt-1.5 w-full border-0 bg-transparent p-0 text-xl font-semibold text-slate-800
                             focus:outline-none focus:ring-0 dark:text-slate-100"
                />
              </div>
              <Button variant="ghost" onClick={onClose} className="text-lg leading-none">✕</Button>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {/* ── 基本欄位 ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label={T.task.drawer.fieldStatus}>
                  <select value={data.statusKey}
                          onChange={e => patch.mutate({ statusKey: e.target.value })}
                          className={SELECT_CLS}>
                    {statuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label={T.task.drawer.fieldPriority}>
                  <select value={data.priority}
                          onChange={e => patch.mutate({ priority: e.target.value })}
                          className={SELECT_CLS}>
                    {(Object.keys(PRIORITY_LABEL) as Array<keyof typeof PRIORITY_LABEL>)
                      .map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                  </select>
                </Field>
                <Field label={T.task.drawer.fieldStart}>
                  <Input type="date" defaultValue={data.startDate?.slice(0, 10) ?? ''}
                         onBlur={e => patch.mutate({ startDate: e.target.value || null })} />
                </Field>
                <Field label={T.task.drawer.fieldDue}>
                  <Input type="date" defaultValue={data.dueDate?.slice(0, 10) ?? ''}
                         onBlur={e => patch.mutate({ dueDate: e.target.value || null })} />
                </Field>
                <Field label={T.task.drawer.fieldProgress}>
                  <Input type="number" min={0} max={100} defaultValue={data.progress}
                         onBlur={e => patch.mutate({ progress: Number(e.target.value) })} />
                </Field>
                <Field label={T.task.drawer.fieldScheduleMode}>
                  <select value={data.scheduleMode}
                          onChange={e => patch.mutate({ scheduleMode: e.target.value })}
                          className={SELECT_CLS}>
                    <option value="AUTO">{T.task.drawer.scheduleAuto}</option>
                    <option value="MANUAL">{T.task.drawer.scheduleManual}</option>
                  </select>
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
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  {T.task.problem.hint}
                </p>
              </div>

              {/* ── 發文追蹤：核心功能 ── */}
              <InquiryTable taskId={taskId} workspaceId={workspaceId}
                            inquiries={data.inquiries} canEdit />

              {/* ── 左右關聯 ── */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                  {T.task.link.title}{' '}
                  <span className="font-normal text-slate-400 dark:text-slate-500">
                    {T.task.link.titleHint}
                  </span>
                </h3>
                <div className="space-y-1.5">
                  {data.links.length === 0 && (
                    <p className="text-sm text-slate-400 dark:text-slate-500">{T.task.link.empty}</p>
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
                        <span className="ml-1.5 text-slate-400 dark:text-slate-500">{l.otherTitle}</span>
                      </span>
                      {l.lagDays !== 0 && (
                        <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                          {T.task.link.lagDays(l.lagDays)}
                        </span>
                      )}
                      <Button variant="ghost" className="text-xs text-slate-400 dark:text-slate-500"
                              onClick={() => delLink.mutate(l.id)}>✕</Button>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-56 flex-1">
                    <Field label={T.task.link.fieldTarget}>
                      <select value={targetId} onChange={e => setTargetId(e.target.value)}
                              className={SELECT_CLS}>
                        <option value="">{T.task.link.pickTask}</option>
                        {allTasks.filter(t => t.id !== taskId).map(t => (
                          <option key={t.id} value={t.id}>{t.ref} {t.title}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="w-60">
                    <Field label={T.task.link.fieldType}>
                      <select value={linkType} onChange={e => setLinkType(e.target.value as LinkType)}
                              className={SELECT_CLS}>
                        <optgroup label={T.task.link.groupScheduling}>
                          {SCHEDULING.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                        <optgroup label={T.task.link.groupSemantic}>
                          {SEMANTIC.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                      </select>
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
                    <span className="font-normal text-slate-400 dark:text-slate-500">
                      {T.task.children.titleHint}
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {data.children.map(c => (
                      <div key={c.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm
                                                 dark:bg-slate-800 dark:text-slate-200">
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{c.ref}</span>
                        <span className="flex-1 truncate">{c.title}</span>
                        <span className="text-xs text-slate-400 dark:text-slate-500">{c.progress}%</span>
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
                      <span className="text-slate-400 dark:text-slate-500">
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
