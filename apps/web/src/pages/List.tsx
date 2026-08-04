import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Api, type Task, type TaskStatus } from '../lib/api'
import { InquiryBadge, Empty, Input, cx } from '../components/ui'
import { Avatar } from '../components/Avatar'
import { rollup, isTaskOverdue } from '../lib/rollup'

const TYPE_LABEL: Partial<Record<Task['type'], string>> = {
  EPIC: '大項目',
  MILESTONE: '里程碑',
  BUG: '缺陷',
}

/** 清單／樹狀視圖：依 parentId 展開階層（上下關聯） */
export default function ListView({
  projectId, tasks, statuses, onOpen, parentForNew,
}: {
  projectId: string
  tasks: Task[]; statuses: TaskStatus[]; onOpen: (id: string) => void
  /** 側欄選了大項目時，最下面那一列新增的任務要掛在它底下 */
  parentForNew?: string | null
}) {
  const qc = useQueryClient()
  const statusName = useMemo(
    () => Object.fromEntries(statuses.map(s => [s.key, s])), [statuses])

  /**
   * 正在替哪一張任務加子任務。
   *
   * 原本要新增子任務只有右上角那一個輸入框，而且它加出來的是「跟目前篩選同一層」的任務 ——
   * 想掛在某一張底下得先選那個大項目、或事後再拖一次。在清單上每一列直接給一個入口，
   * 才對得上使用者的動作：他人就停在那一列上。
   */
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [title, setTitle] = useState('')

  /** 最下面那一列：新增跟目前這一層同級的任務 */
  const [addingTop, setAddingTop] = useState(false)
  const [topTitle, setTopTitle] = useState('')

  /**
   * 狀態直接在清單上改。
   *
   * 本來要改狀態得先點開那一張任務，或去看板拖 —— 但清單正是「一次看一整排」的地方，
   * 逐張點開等於把最順手的動作變成最慢的。
   */
  const setStatus = useMutation({
    mutationFn: (v: { id: string; statusKey: string }) =>
      Api.patchTask(v.id, { statusKey: v.statusKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  })

  const create = useMutation({
    mutationFn: (v: { parentId: string | null; title: string }) =>
      Api.createTask(projectId, { title: v.title, parentId: v.parentId }),
    onSuccess: () => {
      setTitle('')
      setTopTitle('')
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      // 不關掉輸入框：一次要加好幾張子任務是常態，關掉的話每一張都要重點一次
    },
  })

  // 大項目的進度／起迄日由子任務彙總，不直接顯示資料庫存的值
  const rolled = useMemo(() => rollup(tasks), [tasks])
  const parent = parentForNew ? tasks.find(t => t.id === parentForNew) : undefined

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

  const newTop = () => {
    if (!topTitle.trim()) return
    create.mutate({ parentId: parentForNew ?? null, title: topTitle.trim() })
  }

  return (
    <div className="overflow-auto p-4">
      <table className="w-full border-collapse overflow-hidden rounded-lg bg-white text-sm ring-1 ring-slate-200">
        <thead>
          <tr className="bg-slate-50 text-left text-xs font-medium text-slate-500">
            <th className="px-3 py-2">任務</th>
            <th className="w-32 px-3 py-2">負責人</th>
            <th className="w-28 px-3 py-2">狀態</th>
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
              <Fragment key={t.id}>
              <tr onClick={() => onOpen(t.id)}
                  className="group cursor-pointer border-t border-slate-100 hover:bg-slate-50">
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
                    {/* 一直看得到。藏在 hover 底下的話，等於還是只有右上角那一個入口 ——
                        找得到才叫入口，顏色淡一點就不會吵 */}
                    <button
                      onClick={e => {
                        e.stopPropagation()          // 不要順便把任務打開
                        setAddingTo(id => (id === t.id ? null : t.id))
                        setTitle('')
                      }}
                      title={`在「${t.title}」底下新增子任務`}
                      className={cx(
                        'ml-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                        addingTo === t.id
                          ? 'bg-blue-100 text-blue-700'
                          : 'text-slate-300 hover:bg-slate-200 hover:text-slate-700'
                      )}>
                      ＋ 子任務
                    </button>
                  </div>
                </td>
                <td className="px-3 py-2">
                  {t.assigneeName ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"
                          title={t.assigneeName}>
                      <Avatar userId={t.assigneeId} name={t.assigneeName}
                              hasAvatar={t.assigneeHasAvatar} />
                      <span className="truncate">{t.assigneeName}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300">未指派</span>
                  )}
                </td>
                {/* 點在下拉上不要順便把任務打開 */}
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: st?.color ?? '#cbd5e1' }} />
                    <select
                      value={t.statusKey}
                      disabled={setStatus.isPending}
                      onChange={e => setStatus.mutate({ id: t.id, statusKey: e.target.value })}
                      className="-ml-0.5 cursor-pointer rounded border border-transparent bg-transparent
                                 py-0.5 pl-1 pr-5 text-xs text-slate-600
                                 hover:border-slate-300 hover:bg-white
                                 focus:border-blue-500 focus:bg-white focus:outline-none">
                      {statuses.map(s => (
                        <option key={s.key} value={s.key}>{s.name}</option>
                      ))}
                    </select>
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

              {addingTo === t.id && (
                <tr className="border-t border-slate-100 bg-slate-50">
                  <td colSpan={7} className="px-3 py-2">
                    <div className="flex items-center gap-2"
                         style={{ paddingLeft: (t.depth + 1) * 20 }}>
                      <span className="select-none text-slate-300">└</span>
                      <Input
                        autoFocus
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && title.trim()) {
                            create.mutate({ parentId: t.id, title: title.trim() })
                          }
                          if (e.key === 'Escape') { setAddingTo(null); setTitle('') }
                        }}
                        placeholder={`在「${t.title}」底下新增，按 Enter 建立`}
                        className="max-w-md"
                      />
                      <button onClick={() => { setAddingTo(null); setTitle('') }}
                              className="text-xs text-slate-400 hover:text-slate-600">取消</button>
                      <span className="text-xs text-slate-400">
                        建立後輸入框會留著，可以連續加好幾張
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            )
          })}
        </tbody>

        {/* 新增任務的入口就放在清單最後 —— 東西加在哪裡，入口就在哪裡。
            上面每一列的「＋ 子任務」加的是那一張底下的，這裡加的是同一層的 */}
        <tfoot>
          <tr className="border-t border-slate-100">
            <td colSpan={7} className="px-3 py-2">
              {addingTop ? (
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    value={topTitle}
                    onChange={e => setTopTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') newTop()
                      if (e.key === 'Escape') { setAddingTop(false); setTopTitle('') }
                    }}
                    placeholder={parent ? `在「${parent.title}」底下新增，按 Enter 建立`
                                        : '輸入標題後按 Enter 新增任務'}
                    className="max-w-md"
                  />
                  <button onClick={() => { setAddingTop(false); setTopTitle('') }}
                          className="text-xs text-slate-400 hover:text-slate-600">取消</button>
                  <span className="text-xs text-slate-400">
                    建立後輸入框會留著，可以連續加好幾張
                  </span>
                </div>
              ) : (
                <button onClick={() => { setAddingTop(true); setTopTitle('') }}
                        className="rounded px-1.5 py-0.5 text-sm text-slate-400
                                   hover:bg-slate-100 hover:text-slate-700">
                  ＋ 新增任務
                </button>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

const fmt = (d: string | null) => (d ? d.slice(0, 10).replaceAll('-', '/').slice(5) : '—')
