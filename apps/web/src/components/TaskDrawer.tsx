import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type LinkType, type Task, type TaskStatus } from '../lib/api'
import { LINK_LABEL, LINK_CHIP, SCHEDULING, SEMANTIC, linkSentence } from '../lib/linkText'
import { Button, Input, Field, Spinner, InquiryBadge, cx } from './ui'
import { InquiryTable } from './InquiryTable'

const TYPE_LABEL: Partial<Record<Task['type'], string>> = {
  EPIC: '大項目', MILESTONE: '里程碑', BUG: '缺陷',
}

const PRIORITY_LABEL = {
  LOW: '低', NORMAL: '普通', HIGH: '高', URGENT: '緊急',
} as const

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
      e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : '建立關聯失敗'),
  })
  const delLink = useMutation({ mutationFn: (id: string) => Api.deleteLink(id), onSuccess: invalidate })

  const [targetId, setTargetId] = useState('')
  const [linkType, setLinkType] = useState<LinkType>('FS')
  const [lag, setLag] = useState(0)

  const Shell = ({ children }: { children: React.ReactNode }) =>
    variant === 'overlay' ? (
      <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
        <div className="flex h-full w-full max-w-5xl flex-col bg-white shadow-2xl"
             onClick={e => e.stopPropagation()}>
          {children}
        </div>
      </div>
    ) : (
      <div className="flex h-full min-h-0 flex-col bg-white">{children}</div>
    )

  return (
    <Shell>
      <>
        {isLoading || !data ? <Spinner /> : (
          <>
            <header className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500">
                    {data.ref}
                  </span>
                  <InquiryBadge state={data.inquiryState} />
                  {TYPE_LABEL[data.type] && (
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700">
                      {TYPE_LABEL[data.type]}
                    </span>
                  )}
                </div>
                <input
                  defaultValue={data.title}
                  onBlur={e => e.target.value !== data.title && patch.mutate({ title: e.target.value })}
                  className="mt-1.5 w-full border-0 p-0 text-xl font-semibold text-slate-800 focus:outline-none focus:ring-0"
                />
              </div>
              <Button variant="ghost" onClick={onClose} className="text-lg leading-none">✕</Button>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {/* ── 基本欄位 ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="狀態">
                  <select value={data.statusKey}
                          onChange={e => patch.mutate({ statusKey: e.target.value })}
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    {statuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="優先級">
                  <select value={data.priority}
                          onChange={e => patch.mutate({ priority: e.target.value })}
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    {(Object.keys(PRIORITY_LABEL) as Array<keyof typeof PRIORITY_LABEL>)
                      .map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                  </select>
                </Field>
                <Field label="開始日">
                  <Input type="date" defaultValue={data.startDate?.slice(0, 10) ?? ''}
                         onBlur={e => patch.mutate({ startDate: e.target.value || null })} />
                </Field>
                <Field label="結束日">
                  <Input type="date" defaultValue={data.dueDate?.slice(0, 10) ?? ''}
                         onBlur={e => patch.mutate({ dueDate: e.target.value || null })} />
                </Field>
                <Field label="進度 %">
                  <Input type="number" min={0} max={100} defaultValue={data.progress}
                         onBlur={e => patch.mutate({ progress: Number(e.target.value) })} />
                </Field>
                <Field label="排程模式">
                  <select value={data.scheduleMode}
                          onChange={e => patch.mutate({ scheduleMode: e.target.value })}
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="AUTO">自動（依關聯推算日期）</option>
                    <option value="MANUAL">人工鎖定（日期固定不被推動）</option>
                  </select>
                </Field>
              </div>

              {/* ── 目前遇到的問題 ──
                  放在基本欄位下面、發文追蹤上面：它比日期進度更要緊，
                  但它常常就是「發文出去在等回覆」的那個原因，兩者要挨著看 */}
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-700">目前遇到的問題</h3>
                  {data.problem && (
                    <Button variant="ghost" className="text-xs text-slate-500"
                            onClick={() => patch.mutate({ problem: null })}>
                      已解決，清空
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
                  placeholder="現在卡在哪裡？例如：等對方確認規格、測試機還沒到、預算還沒下來"
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm
                             placeholder:text-slate-400 focus:border-blue-500 focus:outline-none
                             focus:ring-2 focus:ring-blue-500/40"
                />
                <p className="mt-1 text-xs text-slate-400">
                  寫了之後，清單、看板、關聯圖上都會標一個「有問題」。
                  解決了就按「已解決，清空」—— 寫過的內容會留在下面的活動紀錄裡。
                </p>
              </div>

              {/* ── 發文追蹤：核心功能 ── */}
              <InquiryTable taskId={taskId} workspaceId={workspaceId}
                            inquiries={data.inquiries} canEdit />

              {/* ── 左右關聯 ── */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  任務關聯 <span className="font-normal text-slate-400">（左右：依賴與語意）</span>
                </h3>
                <div className="space-y-1.5">
                  {data.links.length === 0 && (
                    <p className="text-sm text-slate-400">還沒有任何關聯。</p>
                  )}
                  {data.links.map(l => (
                    <div key={l.id + l.direction}
                         className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm">
                      <span className={cx(
                        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                        SCHEDULING.includes(l.linkType)
                          ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'
                      )}>{LINK_CHIP[l.linkType]}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">
                        {linkSentence(l.linkType, l.direction, l.otherRef)}
                        <span className="ml-1.5 text-slate-400">{l.otherTitle}</span>
                      </span>
                      {l.lagDays !== 0 && (
                        <span className="shrink-0 text-xs text-slate-400">
                          間隔 {l.lagDays > 0 ? '+' : ''}{l.lagDays} 天
                        </span>
                      )}
                      <Button variant="ghost" className="text-xs text-slate-400"
                              onClick={() => delLink.mutate(l.id)}>✕</Button>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-56 flex-1">
                    <Field label="關聯到">
                      <select value={targetId} onChange={e => setTargetId(e.target.value)}
                              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                        <option value="">選擇任務…</option>
                        {allTasks.filter(t => t.id !== taskId).map(t => (
                          <option key={t.id} value={t.id}>{t.ref} {t.title}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="w-60">
                    <Field label="關聯類型">
                      <select value={linkType} onChange={e => setLinkType(e.target.value as LinkType)}
                              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                        <optgroup label="排程（會推動日期）">
                          {SCHEDULING.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                        <optgroup label="語意（不影響排程）">
                          {SEMANTIC.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
                        </optgroup>
                      </select>
                    </Field>
                  </div>
                  <div className="w-28">
                    <Field label="間隔（天）">
                      <Input type="number" value={lag} onChange={e => setLag(Number(e.target.value))}
                             title="正數＝中間要空幾天；負數＝可以提前重疊" />
                    </Field>
                  </div>
                  <Button variant="primary" disabled={!targetId || addLink.isPending}
                          onClick={() => addLink.mutate({ targetId, linkType, lagDays: lag })}>
                    建立關聯
                  </Button>
                </div>
                {linkError && (
                  <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
                    {linkError}
                  </div>
                )}
              </div>

              {/* ── 上下階層 ── */}
              {data.children.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    子任務 <span className="font-normal text-slate-400">（上下：階層）</span>
                  </h3>
                  <div className="space-y-1">
                    {data.children.map(c => (
                      <div key={c.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm">
                        <span className="font-mono text-xs text-slate-500">{c.ref}</span>
                        <span className="flex-1 truncate">{c.title}</span>
                        <span className="text-xs text-slate-400">{c.progress}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── 活動時間軸 ── */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">活動紀錄</h3>
                <ul className="space-y-1 text-xs text-slate-500">
                  {data.activities.slice(0, 15).map(a => (
                    <li key={a.id} className="flex gap-2">
                      <span className="text-slate-400">{new Date(a.createdAt).toLocaleString('zh-TW')}</span>
                      <span className="text-slate-600">{a.actorName ?? '系統'}</span>
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
    case 'CREATED': return '建立了這張任務'
    case 'COMMENT': return `留言：${String(body?.text ?? '')}`
    case 'LINK_CHANGE': {
      const t = String(body?.linkType ?? '') as LinkType
      return `調整關聯（${LINK_CHIP[t] ?? t}）`
    }
    case 'INQUIRY_CHANGE':
      return body?.action === 'ask'
        ? `發文給 ${String(body?.unit ?? '')}`
        : `登錄回覆${body?.repliedByUnit ? `（${String(body.repliedByUnit)}）` : ''}`
    default:
      /*
       * 問題被清空之後，任務上就沒有它了 —— 這一行是唯一查得回「當初卡在哪」
       * 的地方，所以把清掉之前那段字一起寫出來，而不是只說「更新了欄位」。
       */
      if (body && 'problem' in body) {
        const before = body.problemBefore ? String(body.problemBefore) : ''
        return body.problem
          ? `記下目前遇到的問題：${String(body.problem)}`
          : `把問題標為已解決${before ? `（原本：${before}）` : ''}`
      }
      return '更新了欄位'
  }
}
