import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Task, type TaskStatus } from '../lib/api'
import { InquiryBadge, ProblemBadge, Empty, Input, cx } from '../components/ui'
import { Avatar } from '../components/Avatar'
import { useAuth } from '../lib/auth'
import { rollup, isTaskOverdue } from '../lib/rollup'
import { T } from '../strings'

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

  /*
   * 我在這個專案是什麼角色。跟 App 那一層同一組 queryKey，讀到的是快取。
   *
   * 後端（apps/api/src/routes/tasks.ts）：改狀態走的是 PATCH /tasks/:id，
   * 要編輯者以上而且還要是開這張任務的人，專案管理者一律放行；
   * 新增任務只要編輯者，跟「誰開的」無關。
   */
  const { user } = useAuth()
  const { data: project } = useQuery({
    queryKey: ['project', projectId], queryFn: () => Api.project(projectId),
  })

  /** 類型的中文由專案自己定（0011_project_parameters.sql），查不到就不顯示徽章 */
  const typeOf = (key: string) => project?.types?.find(t => t.key === key)?.name ?? ''
  /*
   * 我的角色要從成員名單裡撈自己那一列 —— GET /projects/:id 只回成員名單，
   * 沒有「我是什麼角色」這個欄位（回那個欄位的是專案清單 GET /projects）。
   */
  const role = project?.members.find(m => m.id === user?.id)?.role
  // 專案建立者在建立專案時就拿到 MANAGER，所以判斷一律看角色
  const canCreate = role === 'MANAGER' || role === 'EDITOR'
  const canEditTask = (t: Task) =>
    role === 'MANAGER' || (canCreate && !!user && t.createdById === user.id)

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

  /**
   * 負責人也直接在清單上換，跟狀態同一個道理：一整排看下來，
   * 「這張該給誰」常常是連著好幾張一起決定的。
   *
   * 但這裡**不問交接說明** —— 那是逐張慢慢處理時才寫得出來的東西，
   * 每換一個人就跳一個輸入框，只會讓人一路按取消。要寫就開任務詳情。
   */
  const reassign = useMutation({
    mutationFn: (v: { id: string; assigneeId: string | null }) =>
      Api.reassignTask(v.id, { assigneeId: v.assigneeId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  })

  const members = project?.members ?? []
  /* 現任負責人被移出專案之後，成員名單裡就沒有他了。不補一項回去的話，
     下拉會顯示成名單上的第一個人，看起來像被誰偷偷換掉 */
  const assigneeOptions = (t: Task) =>
    t.assigneeId && !members.some(m => m.id === t.assigneeId)
      ? [...members,
         { id: t.assigneeId, role: '',
           displayName: T.task.reassign.optionFormerMember(t.assigneeName ?? '') }]
      : members

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
      {/* 視窗窄的時候寧可讓整張表左右捲，也不要把任務名稱擠成一個字一行 */}
      {/* 固定欄寬：任務名稱長的時候讓它自己截斷，不要把整張表撐寬到右邊欄位被推出畫面。
          視窗真的太窄時整張表左右捲 */}
      <table className="w-full min-w-[58rem] table-fixed border-collapse overflow-hidden rounded-lg bg-white text-sm ring-1 ring-slate-200
                        dark:bg-slate-900 dark:ring-slate-700">
        <thead>
          <tr className="whitespace-nowrap bg-slate-50 text-left text-xs font-medium text-slate-500
                         dark:bg-slate-800 dark:text-slate-400">
            <th className="px-3 py-2">{T.task.list.colTask}</th>
            <th className="w-40 px-3 py-2">{T.task.list.colAssignee}</th>
            <th className="w-28 px-3 py-2">{T.task.list.colStatus}</th>
            <th className="w-28 px-3 py-2">{T.task.list.colInquiry}</th>
            <th className="w-20 px-3 py-2">{T.task.list.colStart}</th>
            <th className="w-20 px-3 py-2">{T.task.list.colDue}</th>
            <th className="w-24 px-3 py-2">{T.task.list.colProgress}</th>
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
                  className="group cursor-pointer border-t border-slate-100 hover:bg-slate-50
                             dark:border-slate-800 dark:hover:bg-slate-800">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2" style={{ paddingLeft: t.depth * 20 }}>
                    {t.depth > 0 && <span className="select-none text-slate-300 dark:text-slate-500">└</span>}
                    {t.type === 'MILESTONE' && <span className="text-violet-500">◆</span>}
                    {typeOf(t.type) && t.type !== 'MILESTONE' && (
                      <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700
                                       dark:bg-violet-500/15 dark:text-violet-300">
                        {typeOf(t.type)}
                      </span>
                    )}
                    <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-slate-400
                                     dark:text-slate-400">{t.ref}</span>
                    {/* 中文可以在任何一個字之間斷行，不擋住就會被旁邊的徽章與按鈕擠成一直條 */}
                    <span className={cx('min-w-0 truncate', t.type === 'EPIC'
                      ? 'font-medium text-slate-900 dark:text-slate-100'
                      : 'text-slate-800 dark:text-slate-200')}>
                      {t.title}
                    </span>
                    {/* 緊跟在標題後面，不另外開一欄：有問題的任務是少數，
                        為它固定讓出一欄寬度，換來的是整張表每一列都變窄 */}
                    <ProblemBadge problem={t.problem} />
                    {/* 一直看得到。藏在 hover 底下的話，等於還是只有右上角那一個入口 ——
                        找得到才叫入口，顏色淡一點就不會吵。
                        沒有建立任務的權限就整顆不畫 */}
                    {canCreate && (
                    <button
                      onClick={e => {
                        e.stopPropagation()          // 不要順便把任務打開
                        setAddingTo(id => (id === t.id ? null : t.id))
                        setTitle('')
                      }}
                      title={T.task.list.addChildTip(t.title)}
                      className={cx(
                        'ml-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                        addingTo === t.id
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                          : 'text-slate-300 hover:bg-slate-200 hover:text-slate-700 '
                            + 'dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200'
                      )}>
                      {T.task.list.addChild}
                    </button>
                    )}
                  </div>
                </td>
                {/* 點在下拉上不要順便把任務打開 */}
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  {canEditTask(t) ? (
                    <span className="inline-flex max-w-full items-center gap-1.5">
                      {t.assigneeId && t.assigneeName && (
                        <Avatar userId={t.assigneeId} name={t.assigneeName}
                                hasAvatar={t.assigneeHasAvatar} />
                      )}
                      <select
                        value={t.assigneeId ?? ''}
                        disabled={reassign.isPending}
                        title={T.task.reassign.listHint}
                        onChange={e => reassign.mutate({
                          id: t.id, assigneeId: e.target.value || null,
                        })}
                        className="-ml-0.5 min-w-0 cursor-pointer rounded border border-transparent
                                   bg-transparent py-0.5 pl-1 pr-5 text-xs text-slate-600
                                   hover:border-slate-300 hover:bg-white
                                   focus:border-blue-500 focus:bg-white focus:outline-none
                                   dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-900
                                   dark:focus:bg-slate-900">
                        <option value="">{T.common.unassigned}</option>
                        {assigneeOptions(t).map(m => (
                          <option key={m.id} value={m.id}>{m.displayName}</option>
                        ))}
                      </select>
                    </span>
                  ) : t.assigneeName ? (
                    /* 改不動就不要畫成下拉。游標停著才說明原因 */
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300"
                          title={T.task.permission.cannotChangeAssignee}>
                      <Avatar userId={t.assigneeId} name={t.assigneeName}
                              hasAvatar={t.assigneeHasAvatar} />
                      <span className="truncate">{t.assigneeName}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300 dark:text-slate-500"
                          title={T.task.permission.cannotChangeAssignee}>
                      {T.common.unassigned}
                    </span>
                  )}
                </td>
                {/* 點在下拉上不要順便把任務打開 */}
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: st?.color ?? '#cbd5e1' }} />
                    {canEditTask(t) ? (
                      <select
                        value={t.statusKey}
                        disabled={setStatus.isPending}
                        onChange={e => setStatus.mutate({ id: t.id, statusKey: e.target.value })}
                        className="-ml-0.5 cursor-pointer rounded border border-transparent bg-transparent
                                   py-0.5 pl-1 pr-5 text-xs text-slate-600
                                   hover:border-slate-300 hover:bg-white
                                   focus:border-blue-500 focus:bg-white focus:outline-none
                                   dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-900
                                   dark:focus:bg-slate-900">
                        {statuses.map(s => (
                          <option key={s.key} value={s.key}>{s.name}</option>
                        ))}
                      </select>
                    ) : (
                      /* 改不動就不要畫成下拉。游標停著才說明原因，
                         每一列都印一句「沒有權限」會把整張表變成告示欄 */
                      <span className="py-0.5 text-xs text-slate-600 dark:text-slate-300"
                            title={T.task.permission.cannotChangeStatus}>
                        {st?.name ?? T.common.none}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2"><InquiryBadge state={t.inquiryState} /></td>
                <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{fmt(startDate)}</td>
                {/* 只有「任務本身逾期」才染紅。單位逾期未回是另一件事，走上一欄的徽章 */}
                <td className={cx('px-3 py-2 text-xs', overdue
                      ? 'font-medium text-red-600 dark:text-red-400'
                      : 'text-slate-500 dark:text-slate-400')}
                    title={overdue ? T.task.list.overdueTip : undefined}>
                  {fmt(dueDate)}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
                        title={r?.derived
                          ? T.task.list.derivedProgressTip(r.totalCount, r.doneCount)
                          : undefined}>
                    <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-slate-200
                                     dark:bg-slate-700">
                      <span className={cx('block h-full', progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                            style={{ width: `${progress}%` }} />
                    </span>
                    <span className="tabular-nums">{progress}%</span>
                    {r?.derived && <span className="text-slate-300 dark:text-slate-500" aria-hidden>∑</span>}
                  </span>
                </td>
              </tr>

              {addingTo === t.id && (
                <tr className="border-t border-slate-100 bg-slate-50
                               dark:border-slate-800 dark:bg-slate-800">
                  <td colSpan={7} className="px-3 py-2">
                    <div className="flex items-center gap-2"
                         style={{ paddingLeft: (t.depth + 1) * 20 }}>
                      <span className="select-none text-slate-300 dark:text-slate-500">└</span>
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
                        placeholder={T.task.list.addChildPlaceholder(t.title)}
                        className="max-w-md"
                      />
                      <button onClick={() => { setAddingTo(null); setTitle('') }}
                              className="text-xs text-slate-400 hover:text-slate-600
                                         dark:text-slate-400 dark:hover:text-slate-300">
                        {T.common.cancel}
                      </button>
                      <span className="text-xs text-slate-400 dark:text-slate-400">
                        {T.task.list.keepOpenHint}
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
            上面每一列的「＋ 子任務」加的是那一張底下的，這裡加的是同一層的。
            沒有建立任務的權限就整列不畫 */}
        {canCreate && (
        <tfoot>
          <tr className="border-t border-slate-100 dark:border-slate-800">
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
                    placeholder={parent ? T.task.list.addChildPlaceholder(parent.title)
                                        : T.task.list.addTaskPlaceholder}
                    className="max-w-md"
                  />
                  <button onClick={() => { setAddingTop(false); setTopTitle('') }}
                          className="text-xs text-slate-400 hover:text-slate-600
                                     dark:text-slate-400 dark:hover:text-slate-300">
                    {T.common.cancel}
                  </button>
                  <span className="text-xs text-slate-400 dark:text-slate-400">
                    {T.task.list.keepOpenHint}
                  </span>
                </div>
              ) : (
                <button onClick={() => { setAddingTop(true); setTopTitle('') }}
                        className="rounded px-1.5 py-0.5 text-sm text-slate-400
                                   hover:bg-slate-100 hover:text-slate-700
                                   dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                  {T.task.list.addTask}
                </button>
              )}
            </td>
          </tr>
        </tfoot>
        )}
      </table>
    </div>
  )
}

const fmt = (d: string | null) => (d ? d.slice(0, 10).replaceAll('-', '/').slice(5) : T.common.none)
