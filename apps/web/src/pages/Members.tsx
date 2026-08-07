import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api } from '../lib/api'
import type { MemberTask, PastMemberTask, ProjectParam, TaskStatus } from '../lib/api'
import { Avatar } from '../components/Avatar'
import { Input, Spinner, Empty, InquiryBadge, cx } from '../components/ui'
import { useRemembered } from '../lib/remember'
import { T } from '../strings'

/**
 * 成員頁：左邊挑一個人，右邊看他的任務。
 *
 * 兩區的差別是這一頁存在的理由：
 *  - **目前的所有任務**：現在指派給他的全部，**不分狀態、含已完成** ——
 *    濾掉做完的會讓「他做過什麼」憑空少一半。
 *  - **曾經的任務**：他經手過、後來轉派給別人的。來源是**轉派的活動紀錄**，
 *    不是「已完成的任務」—— 做完的在清單頁篩狀態就看得到，再做一次沒有意義；
 *    「這張以前是誰在做」才是別的地方查不到的東西。
 *
 * 只看得到這個專案的任務（跟對外詢問同一個道理，那是專案裡面的東西）。
 * 授權在後端：同專案的人都看得到，不要求管理者 —— 這是「誰在做什麼」，
 * 不是管理功能。
 */
export default function MembersView({ projectId, onOpenTask }: {
  projectId: string
  /**
   * 頁籤那一排統一把工作區帶進來。這一頁用不到（成員與任務都只認專案），
   * 但接線的地方不必為了它長得不一樣。
   */
  workspaceId: string
  /** 點一列任務 → 在右邊打開那張任務的詳情 */
  onOpenTask: (taskId: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const { data: memberData, isLoading } = useQuery({
    queryKey: ['members', projectId],
    queryFn: () => Api.members(projectId),
    enabled: !!projectId,
  })

  /**
   * 狀態的名字與顏色。跟 App 那一層同一組 queryKey，讀到的是快取，
   * 不會為了這一頁再問一次後端。顏色是他在系統參數頁挑的，照原樣用。
   */
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => Api.project(projectId),
    enabled: !!projectId,
  })
  const statusOf = useMemo(() => {
    const m = new Map<string, TaskStatus>()
    for (const s of project?.statuses ?? []) m.set(s.key, s)
    return (key: string) => m.get(key)
  }, [project])

  /**
   * 名單上每個人後面那個「手上 N 張」。
   *
   * 沒有另外開一個統計端點：任務清單本來就在快取裡（清單、看板、甘特都用
   * `['tasks', projectId]`），數字就地數得出來，還能跟那些畫面永遠一致。
   */
  const { data: taskData } = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => Api.tasks(projectId),
    enabled: !!projectId,
  })
  const countOf = useMemo(() => {
    const n = new Map<string, number>()
    for (const t of taskData?.tasks ?? []) {
      if (t.assigneeId) n.set(t.assigneeId, (n.get(t.assigneeId) ?? 0) + 1)
    }
    return (userId: string) => n.get(userId) ?? 0
  }, [taskData])

  const members = useMemo(() => {
    const k = q.trim().toLowerCase()
    const all = memberData?.members ?? []
    if (!k) return all
    return all.filter(m =>
      m.displayName.toLowerCase().includes(k) || m.email.toLowerCase().includes(k))
  }, [memberData, q])

  const picked = useMemo(
    () => (memberData?.members ?? []).find(m => m.id === selected) ?? null,
    [memberData, selected]
  )

  if (isLoading) return <Spinner />

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── 左：這個專案的成員 ── */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white
                        dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {T.member.listTitle}
          </h2>
          <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-400">{T.member.listHint}</p>
          <div className="mt-2">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder={T.member.search} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {members.length === 0 && <Empty>{T.member.empty}</Empty>}
          {members.map(m => {
            const on = m.id === selected
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelected(m.id)}
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                  on
                    ? 'bg-blue-50 dark:bg-blue-500/15'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                )}
              >
                <Avatar userId={m.id} name={m.displayName} hasAvatar={m.hasAvatar} size="md" />
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-sm',
                    on
                      ? 'font-medium text-blue-700 dark:text-blue-300'
                      : 'text-slate-800 dark:text-slate-100')}>
                    {m.displayName}
                  </span>
                  <span className="block truncate text-xs text-slate-400 dark:text-slate-400">
                    {T.member.role[m.role]}
                  </span>
                </span>
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px]
                                 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {T.member.currentCount(countOf(m.id))}
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── 右：他手上與經手過的任務 ── */}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {!picked
          ? <Empty>{T.member.pickHint}</Empty>
          /*
           * key 換人就整個重掛。底下的收合偏好用 useRemembered 存，
           * 那個 hook 只在掛載時讀一次 —— 不重掛的話，換一個人看到的
           * 會是上一個人的收合狀態。
           */
          : <MemberTasks key={picked.id} projectId={projectId} member={picked}
                         types={project?.types} statusOf={statusOf} onOpenTask={onOpenTask} />}
      </div>
    </div>
  )
}

type Member = NonNullable<Awaited<ReturnType<typeof Api.members>>['members'][number]>

function MemberTasks({ projectId, member, types, statusOf, onOpenTask }: {
  projectId: string
  member: Member
  /** 這個專案自己的任務種類。`undefined` 是「專案還沒讀到」，不是「一種都沒有」 */
  types: ProjectParam[] | undefined
  statusOf: (key: string) => TaskStatus | undefined
  onOpenTask: (taskId: string) => void
}) {
  /**
   * 快取鍵裡的 id 是**被看的那個人**，不是登入的人 ——
   * 換帳號時整份快取會被清掉（見 lib 的 qc.clear()），這裡不必再帶一次。
   */
  const { data, isLoading } = useQuery({
    queryKey: ['member-tasks', projectId, member.id],
    queryFn: () => Api.memberTasks(projectId, member.id),
  })

  /*
   * 收起來的是哪幾組。跟週檢視同一個取捨：存的是「收合」而不是「展開」的清單 ——
   * 專案之後新增種類時，沒被收過的組一律是展開的；反過來存的話，
   * 新種類一出現就是收著的，而沒有人會想到要去展開一個自己剛建出來的東西。
   *
   * 鍵含專案**與成員**：不同人的收合狀態混在一起的話，看完 A 再點 B
   * 會莫名其妙收起一堆組。兩區各自記（前綴 current: / past:）——
   * 手上那些想全開著、以前經手的想收起來，是很正常的看法。
   */
  const [collapsed, setCollapsed] = useRemembered<string[]>(
    `member.collapsed.${projectId}.${member.id}`, [])
  const toggler = (area: 'current' | 'past') => ({
    isCollapsed: (key: string) => collapsed.includes(`${area}:${key}`),
    onToggle: (key: string) => {
      const k = `${area}:${key}`
      setCollapsed(collapsed.includes(k) ? collapsed.filter(x => x !== k) : [...collapsed, k])
    },
  })

  const currentGroups = useMemo(
    () => groupByType(data?.current ?? [], types ?? []), [data, types])
  const pastGroups = useMemo(
    () => groupByType(data?.past ?? [], types ?? []), [data, types])

  return (
    <div>
      <div className="mb-4 flex items-center gap-2.5">
        <Avatar userId={member.id} name={member.displayName}
                hasAvatar={member.hasAvatar} size="md" />
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
            {member.displayName}
          </div>
          <div className="truncate text-xs text-slate-400 dark:text-slate-400">
            {T.member.role[member.role]}
          </div>
        </div>
      </div>

      {/* 種類還沒讀到就先不畫：先畫出來的話每張任務都會落到「未對應的類型」那一組，
          等專案讀進來才跳回正確的分組，看起來像資料錯了又自己好了 */}
      {isLoading || !types ? <Spinner /> : (
        <div className="space-y-6">
          <Section title={T.member.current.title} hint={T.member.current.hint}
                   count={data?.current.length ?? 0}>
            {data?.current.length
              ? <TaskTable groups={currentGroups} statusOf={statusOf} onOpenTask={onOpenTask}
                           {...toggler('current')} />
              : <Empty>{T.member.current.empty}</Empty>}
          </Section>

          <Section title={T.member.past.title} hint={T.member.past.hint}
                   count={data?.past.length ?? 0}>
            {data?.past.length
              ? <TaskTable
                  groups={pastGroups} statusOf={statusOf} onOpenTask={onOpenTask}
                  {...toggler('past')}
                  extra={t => <Handover task={t as PastMemberTask} />} />
              : <Empty>{T.member.past.empty}</Empty>}
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, hint, count, children }: {
  title: string; hint: string; count: number; children: ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{title}</h3>
        <span className="rounded bg-slate-100 px-1.5 text-xs text-slate-500
                         dark:bg-slate-800 dark:text-slate-400">{count}</span>
        <span className="text-xs text-slate-400 dark:text-slate-400">{hint}</span>
      </div>
      <div className="overflow-hidden rounded-lg bg-white ring-1 ring-slate-200
                      dark:bg-slate-900 dark:ring-slate-700">
        {children}
      </div>
    </section>
  )
}

/** 一組任務：一個種類（或最後那個「未對應的類型」）底下的所有任務 */
interface TypeGroup {
  key: string
  name: string
  color: string
  tasks: MemberTask[]
}

/**
 * 照任務種類分組。
 *
 * 組的順序**照系統參數自己的順序**（後端已經按 rank 給），這一頁不另外排 ——
 * 各畫面各排一套的話，同一個專案在不同頁看到的先後會對不起來。
 * 空的組不畫；指到已經被刪掉的種類的任務不能就這樣消失，收成最後一組。
 */
function groupByType(tasks: MemberTask[], types: ProjectParam[]): TypeGroup[] {
  const byKey = new Map<string, MemberTask[]>()
  for (const t of tasks) {
    const list = byKey.get(t.type)
    if (list) list.push(t)
    else byKey.set(t.type, [t])
  }

  const out: TypeGroup[] = []
  for (const ty of types) {
    const list = byKey.get(ty.key)
    if (!list) continue
    out.push({ key: ty.key, name: ty.name, color: ty.color, tasks: list })
    byKey.delete(ty.key)
  }

  const orphan = [...byKey.values()].flat()
  if (orphan.length > 0) {
    out.push({
      key: '__unknown__', name: T.member.group.unknownType,
      color: '#94a3b8', tasks: orphan,
    })
  }
  return out
}

/**
 * 兩區共用同一組欄位。差別只在「曾經的任務」那一區的標題底下多掛幾行
 * （現在是誰負責、哪天轉出去的、交接說明）—— 那三件事撐不起獨立的欄位，
 * 而且它們講的是同一張任務的來龍去脈，擠在一起讀才連得起來。
 *
 * 分組是一個種類一個 `<tbody>`：欄位標題只放一次，每一組再放一次會把整頁切碎，
 * 而共用同一張表格的欄寬，收合到剩兩組時各欄也還對得齊。
 * 每一列不再標種類徽章 —— 組標題已經寫著同一個名字了。
 */
function TaskTable({ groups, statusOf, onOpenTask, isCollapsed, onToggle, extra }: {
  groups: TypeGroup[]
  statusOf: (key: string) => TaskStatus | undefined
  onOpenTask: (taskId: string) => void
  isCollapsed: (key: string) => boolean
  onToggle: (key: string) => void
  extra?: (t: MemberTask) => ReactNode
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="bg-slate-50 text-left text-xs font-medium text-slate-500
                       dark:bg-slate-800 dark:text-slate-400">
          <th className="px-3 py-2">{T.member.columns.task}</th>
          <th className="w-40 px-3 py-2">{T.member.columns.status}</th>
          <th className="w-28 px-3 py-2">{T.member.columns.due}</th>
          <th className="w-32 px-3 py-2">{T.member.columns.progress}</th>
        </tr>
      </thead>

      {groups.map(g => {
        const off = isCollapsed(g.key)
        return (
          <tbody key={g.key}>
            {/* 組標題：整條都可以按，不是只有那個箭頭 ——
                要按中一個 12px 的三角形是件很煩的事。
                種類色是使用者自己挑的，只拿來當圓點，不當底色也不當文字色
                （深淺不受控，深色模式下會有一半讀不到） */}
            <tr>
              <td colSpan={4}
                  className="border-t border-slate-100 p-0 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => onToggle(g.key)}
                  aria-expanded={!off}
                  aria-label={off ? T.member.group.expand(g.name) : T.member.group.collapse(g.name)}
                  className="flex w-full items-center gap-2 bg-slate-50/60 px-3 py-1.5 text-left
                             transition-colors hover:bg-slate-100
                             dark:bg-slate-800/40 dark:hover:bg-slate-800"
                >
                  <span aria-hidden
                        className={cx('shrink-0 text-[10px] text-slate-400 transition-transform',
                                      'dark:text-slate-400', off && '-rotate-90')}>
                    ▼
                  </span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: g.color }} />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {g.name}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-400">
                    {T.member.group.count(g.tasks.length)}
                  </span>
                </button>
              </td>
            </tr>

            {!off && g.tasks.map(t => {
              const st = statusOf(t.statusKey)
              return (
                <tr
                  key={t.id}
                  onClick={() => onOpenTask(t.id)}
                  className="cursor-pointer border-t border-slate-100 align-top
                             hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                >
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[11px] text-slate-400 dark:text-slate-400">
                        {t.ref}
                      </span>
                      <span className="text-slate-800 dark:text-slate-100">{t.title}</span>
                      <InquiryBadge state={t.inquiryState} />
                    </div>
                    {extra?.(t)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 text-xs
                                     text-slate-600 dark:text-slate-300">
                      {/* 狀態色是他自己挑的，照原樣畫，不套深色模式的色階 */}
                      <span className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: st?.color ?? '#cbd5e1' }} />
                      {st?.name ?? t.statusKey}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {/* 日期是字串，原樣顯示 —— 轉成 Date 再轉回來會被時區推掉一天 */}
                    {t.dueDate ? t.dueDate.slice(0, 10) : T.member.noDue}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                      <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-slate-200
                                       dark:bg-slate-700">
                        <span className={cx('block h-full',
                          t.progress >= 100 ? 'bg-emerald-500' : 'bg-blue-500')}
                              style={{ width: `${t.progress}%` }} />
                      </span>
                      <span className="tabular-nums">{t.progress}%</span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        )
      })}
    </table>
  )
}

/** 曾經的任務多出來的那三件事：現在在誰身上、哪天轉的、交接時說了什麼 */
function Handover({ task }: { task: PastMemberTask }) {
  return (
    <div className="mt-1 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1">
          {task.assigneeId && (
            <Avatar userId={task.assigneeId} name={task.assigneeName}
                    hasAvatar={task.assigneeHasAvatar} size="sm" />
          )}
          {task.assigneeName
            ? T.member.past.nowWith(task.assigneeName)
            : T.member.past.nowNobody}
        </span>
        <span className="text-slate-400 dark:text-slate-400">
          {T.member.past.handedOn(task.handedOverOn)}
        </span>
      </div>
      {task.handoverNote && (
        <div className="text-slate-500 dark:text-slate-400">
          {T.member.past.note(task.handoverNote)}
        </div>
      )}
    </div>
  )
}
