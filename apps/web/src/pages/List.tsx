import { useMemo } from 'react'
import type { Task, TaskStatus } from '../lib/api'
import { InquiryBadge, Empty, cx } from '../components/ui'
import { rollup, isTaskOverdue } from '../lib/rollup'

const TYPE_LABEL: Partial<Record<Task['type'], string>> = {
  EPIC: '大項目',
  MILESTONE: '里程碑',
  BUG: '缺陷',
}

/** 清單／樹狀視圖：依 parentId 展開階層（上下關聯） */
export default function ListView({
  tasks, statuses, onOpen,
}: {
  tasks: Task[]; statuses: TaskStatus[]; onOpen: (id: string) => void
}) {
  const statusName = useMemo(
    () => Object.fromEntries(statuses.map(s => [s.key, s])), [statuses])

  // 大項目的進度／起迄日由子任務彙總，不直接顯示資料庫存的值
  const rolled = useMemo(() => rollup(tasks), [tasks])

  // 依階層排序：父任務後面緊接自己的子樹
  const ordered = useMemo(() => {
    const byParent = new Map<string | null, Task[]>()
    for (const t of tasks) {
      const k = t.parentId ?? null
      byParent.set(k, [...(byParent.get(k) ?? []), t])
    }
    for (const list of byParent.values()) list.sort((a, b) => Number(a.rank) - Number(b.rank))

    const out: Array<Task & { depth: number }> = []
    const walk = (parent: string | null, depth: number) => {
      for (const t of byParent.get(parent) ?? []) {
        out.push({ ...t, depth })
        if (depth < 10) walk(t.id, depth + 1)
      }
    }
    walk(null, 0)
    // 父任務被過濾掉時，孤兒也要顯示，不然會憑空消失
    const seen = new Set(out.map(t => t.id))
    for (const t of tasks) if (!seen.has(t.id)) out.push({ ...t, depth: 0 })
    return out
  }, [tasks])

  if (!ordered.length) return <Empty>這個專案還沒有任務。按右上角「＋ 新增任務」開始。</Empty>

  return (
    <div className="overflow-auto p-4">
      <table className="w-full border-collapse overflow-hidden rounded-lg bg-white text-sm ring-1 ring-slate-200">
        <thead>
          <tr className="bg-slate-50 text-left text-xs font-medium text-slate-500">
            <th className="px-3 py-2">任務</th>
            <th className="w-24 px-3 py-2">狀態</th>
            <th className="w-32 px-3 py-2">發文追蹤</th>
            <th className="w-24 px-3 py-2">開始</th>
            <th className="w-24 px-3 py-2">結束</th>
            <th className="w-20 px-3 py-2">進度</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(t => {
            const st = statusName[t.statusKey]
            const r = rolled.get(t.id)
            const progress = r?.progress ?? t.progress
            const startDate = r?.startDate ?? t.startDate
            const dueDate = r?.dueDate ?? t.dueDate
            const overdue = isTaskOverdue(dueDate, progress)
            return (
              <tr key={t.id} onClick={() => onOpen(t.id)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2" style={{ paddingLeft: t.depth * 20 }}>
                    {t.depth > 0 && <span className="select-none text-slate-300">└</span>}
                    {t.type === 'MILESTONE' && <span className="text-violet-500">◆</span>}
                    {TYPE_LABEL[t.type] && t.type !== 'MILESTONE' && (
                      <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700">
                        {TYPE_LABEL[t.type]}
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-slate-400">{t.ref}</span>
                    <span className={cx(t.type === 'EPIC' ? 'font-medium text-slate-900' : 'text-slate-800')}>
                      {t.title}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                    <span className="h-2 w-2 rounded-full" style={{ background: st?.color ?? '#cbd5e1' }} />
                    {st?.name ?? t.statusKey}
                  </span>
                </td>
                <td className="px-3 py-2"><InquiryBadge state={t.inquiryState} /></td>
                <td className="px-3 py-2 text-xs text-slate-500">{fmt(startDate)}</td>
                {/* 只有「任務本身逾期」才染紅。單位逾期未回是另一件事，走上一欄的徽章 */}
                <td className={cx('px-3 py-2 text-xs', overdue ? 'font-medium text-red-600' : 'text-slate-500')}
                    title={overdue ? '已過結束日且尚未完成' : undefined}>
                  {fmt(dueDate)}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-slate-500"
                        title={r?.derived
                          ? `由 ${r.totalCount} 個子任務加權平均算出（已完成 ${r.doneCount} 個）`
                          : undefined}>
                    <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-slate-200">
                      <span className={cx('block h-full', progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                            style={{ width: `${progress}%` }} />
                    </span>
                    <span className="tabular-nums">{progress}%</span>
                    {r?.derived && <span className="text-slate-300" aria-hidden>∑</span>}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const fmt = (d: string | null) => (d ? d.slice(0, 10).replaceAll('-', '/').slice(5) : '—')
