import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api } from '../lib/api'
import { Spinner, Empty, cx } from '../components/ui'

/**
 * 發文追蹤看板：跨專案，三欄（待回覆 / 逾期未回 / 已回覆）。
 * 可切換「依單位分組」—— 一眼看出「資訊部身上壓著 8 件、其中 3 件逾期」。
 */
export default function InquiryBoard({ workspaceId, onOpenTask }: {
  workspaceId: string
  /** 點卡片 → 跳到那張任務所屬的專案並打開詳情抽屜 */
  onOpenTask: (projectId: string, taskId: string) => void
}) {
  const [groupByUnit, setGroupByUnit] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['inquiry-board', workspaceId],
    queryFn: () => Api.inquiryBoard(workspaceId),
  })
  const { data: stats } = useQuery({
    queryKey: ['inquiry-stats', workspaceId],
    queryFn: () => Api.inquiryStats(workspaceId),
  })

  const cols = useMemo(() => {
    const all = data?.inquiries ?? []
    return [
      { key: 'AWAITING', title: '待回覆', color: 'bg-blue-500',
        items: all.filter(i => i.status === 'AWAITING') },
      { key: 'OVERDUE', title: '逾期未回', color: 'bg-red-500',
        items: all.filter(i => i.status === 'OVERDUE') },
      { key: 'REPLIED', title: '已回覆', color: 'bg-emerald-500',
        items: all.filter(i => i.status === 'REPLIED') },
    ]
  }, [data])

  if (isLoading) return <Spinner />

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-base font-semibold text-slate-800">發文追蹤</h2>
        <span className="text-sm text-slate-400">跨專案，看所有發出去的事情回了沒</span>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={groupByUnit}
                 onChange={e => setGroupByUnit(e.target.checked)} />
          依單位分組
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {cols.map(col => (
          <div key={col.key} className="rounded-lg bg-slate-100/80 ring-1 ring-slate-200">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className={cx('h-2 w-2 rounded-full', col.color)} />
              <span className="text-sm font-semibold text-slate-700">{col.title}</span>
              <span className="rounded bg-white px-1.5 text-xs text-slate-500">{col.items.length}</span>
            </div>
            <div className="space-y-2 px-2 pb-3">
              {col.items.length === 0 && (
                <div className="py-6 text-center text-xs text-slate-400">沒有項目</div>
              )}
              {groupByUnit
                ? Object.entries(groupBy(col.items, i => i.askedToUnit)).map(([unit, items]) => (
                    <div key={unit}>
                      <div className="px-1 py-1 text-xs font-medium text-slate-500">
                        {unit} <span className="text-slate-400">({items.length})</span>
                      </div>
                      <div className="space-y-2">
                        {items.map(i => <InquiryCard key={i.id} item={i} onOpen={onOpenTask} />)}
                      </div>
                    </div>
                  ))
                : col.items.map(i => <InquiryCard key={i.id} item={i} onOpen={onOpenTask} />)}
            </div>
          </div>
        ))}
      </div>

      {/* ── 單位統計：因為單位是獨立欄位而不是埋在留言裡，這些才查得出來 ── */}
      {stats && stats.byUnit.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">單位回覆統計</h3>
          <div className="overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <th className="px-3 py-2">單位</th>
                  <th className="px-3 py-2">發文次數</th>
                  <th className="px-3 py-2">已回覆</th>
                  <th className="px-3 py-2">目前逾期</th>
                  <th className="px-3 py-2">平均回覆天數</th>
                  <th className="px-3 py-2">逾期回覆率</th>
                </tr>
              </thead>
              <tbody>
                {stats.byUnit.map(u => (
                  <tr key={u.unit} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-800">{u.unit}</td>
                    <td className="px-3 py-2 text-slate-600">{u.totalAsked}</td>
                    <td className="px-3 py-2 text-slate-600">{u.totalReplied}</td>
                    <td className={cx('px-3 py-2', u.currentOverdue > 0 ? 'font-medium text-red-600' : 'text-slate-400')}>
                      {u.currentOverdue || '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {u.avgDaysToReply != null ? `${u.avgDaysToReply} 天` : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {u.lateReplyRate != null ? `${u.lateReplyRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {stats.transferred.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
              <div className="mb-1 font-medium text-amber-900">轉單位回覆的案例</div>
              <div className="text-amber-800">
                {stats.transferred.map(t => (
                  <span key={t.askedToUnit + t.repliedByUnit} className="mr-4">
                    {t.askedToUnit} → {t.repliedByUnit}（{t.count} 次）
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-amber-700/80">
                提問側與回覆側分開存，才問得出這件事。
              </p>
            </div>
          )}
        </div>
      )}

      {(data?.inquiries.length ?? 0) === 0 && (
        <Empty>還沒有任何發文紀錄。到任務詳情頁的「發文追蹤」新增一筆。</Empty>
      )}
    </div>
  )
}

type BoardItem = Awaited<ReturnType<typeof Api.inquiryBoard>>['inquiries'][number]

function InquiryCard({ item, onOpen }: {
  item: BoardItem
  onOpen: (projectId: string, taskId: string) => void
}) {
  const transferred = item.repliedByUnit && item.repliedByUnit !== item.askedToUnit
  return (
    <button
      type="button"
      onClick={() => onOpen(item.projectId, item.taskId)}
      title={`開啟 ${item.taskRef}：${item.taskTitle}`}
      className="w-full cursor-pointer rounded-lg bg-white p-2.5 text-left ring-1 ring-slate-200
                 transition hover:ring-2 hover:ring-slate-400
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.projectColor }} />
        <span className="font-mono text-[11px] text-slate-400">{item.taskRef}</span>
        <span className="truncate text-[11px] text-slate-400">{item.projectName}</span>
        <span aria-hidden className="ml-auto text-[11px] text-slate-300">↗</span>
      </div>
      <div className="text-sm leading-snug text-slate-800">{item.taskTitle}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
          {item.askedToUnit}
        </span>
        {item.askedToPerson && <span className="text-slate-400">{item.askedToPerson}</span>}
        {transferred && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
            → {item.repliedByUnit}
          </span>
        )}
      </div>
      <div className="mt-1.5 text-[11px] text-slate-400">
        {item.status === 'OVERDUE' && (
          <span className="font-medium text-red-600">逾期 {item.daysOverdue} 天</span>
        )}
        {item.status === 'AWAITING' && <span>已等 {item.daysElapsed} 天</span>}
        {item.status === 'REPLIED' && item.daysToReply != null && (
          <span className="text-emerald-600">{item.daysToReply} 天回覆</span>
        )}
        {item.dueDate && <span className="ml-2">期望 {String(item.dueDate).slice(5, 10)}</span>}
      </div>
    </button>
  )
}

function groupBy<T>(items: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const i of items) (out[key(i)] ??= []).push(i)
  return out
}
