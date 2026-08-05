import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type LinkType, type Task, type TaskDetail, type TaskStatus } from '../lib/api'
import { LINK_LABEL, LINK_CHIP, SCHEDULING, SEMANTIC, linkSentence } from '../lib/linkText'
import { Button, Input, Select, Field, Spinner, cx } from './ui'
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

  /** 按下保存才送出。只送動過的那幾格 */
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => Api.patchTask(taskId, v),
    onSuccess: () => { setDraft({}); invalidate() },
  })
  const remove = useMutation({
    mutationFn: () => Api.deleteTask(taskId),
    onSuccess: () => { invalidate(); onClose() },
  })
  /** 刪除是兩段式：按一次問一句，再按一次才真的刪 */
  const [confirmDelete, setConfirmDelete] = useState(false)

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

  /**
   * 還有幾件對外詢問沒回。已回覆的不算 —— 那件事已經完成了。
   * 這個數字決定「做完了」那幾個狀態畫不畫得出來（見 AGENTS.md）。
   */
  const openInquiries = (data?.inquiries ?? []).filter(q => !q.isReplied).length

  /** 標題列上那幾顆：還在等的、已經逾期的、還是全部都回來了 */
  const inquiryCounts = (() => {
    const all = data?.inquiries ?? []
    const overdue = all.filter(q => !q.isReplied && q.status === 'OVERDUE').length
    const waiting = all.filter(q => !q.isReplied && q.status !== 'OVERDUE').length
    return { waiting, overdue, allReplied: all.length > 0 && waiting + overdue === 0 }
  })()

  /*
   * ── 草稿 ──
   *
   * 欄位改了先留在這裡，按「保存」才送出。原本是改一格存一次 ——
   * 改三個欄位就是三筆活動紀錄、三次重畫，而且中途反悔沒有辦法收回。
   *
   * 存的是「動過的那幾格」而不是整份任務：只送真的改過的欄位，
   * 後端的活動紀錄才不會每次都寫上一整排沒變的值。
   *
   * 「目前遇到的問題」不走這裡，維持改完就存 —— 那一欄的權限跟其他欄位不同
   * （誰遇到誰寫，不必是開任務的人），混進同一顆保存鈕的話，
   * 沒有編輯權的人就沒有東西可以按。
   */
  type Draft = Partial<Pick<TaskDetail,
    'title' | 'type' | 'statusKey' | 'priority' | 'progress'
    | 'startDate' | 'dueDate' | 'scheduleMode'>>
  const [draft, setDraft] = useState<Draft>({})
  const edit = (v: Draft) => setDraft(d => ({ ...d, ...v }))
  /** 畫面上顯示的值：伺服器的資料疊上還沒保存的修改 */
  const form = { ...(data as TaskDetail | undefined), ...draft } as TaskDetail
  const dirty = !!data && (Object.keys(draft) as Array<keyof Draft>)
    .some(k => draft[k] !== data[k])

  /**
   * 選了「做完了」那一類、但還有對外詢問沒回 —— 保存鈕要變灰並說明原因。
   * 下拉那邊也已經把那幾個選項灰掉了，這裡是同一條規則的第二道 ——
   * 既有資料本來就可能停在做完的狀態上，那種情況下拉留著它，
   * 但只要他動了別的欄位就會走到這裡來。
   */
  const saveBlocked = openInquiries > 0
    && statuses.some(s => s.key === form?.statusKey && s.category === 'DONE')

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
              {/* flex-1 不能省：沒有它這一格只有內容寬，
                  標題就只用得到畫面的一小段，長標題會被擠成很窄的一直條 */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500
                                   dark:bg-slate-800 dark:text-slate-400">
                    {data.ref}
                  </span>
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

                  {/*
                    * 對外詢問的狀況接在種類後面。原本這裡是一顆只講狀態的徽章
                    * （待回覆／逾期未回），但一張任務可以同時問好幾個單位 ——
                    * 沒有數字就看不出來是還剩一件還是剩五件。
                    * 寫法跟側欄一致（「外 1」「逾 1」），兩邊要對得起來。
                    */}
                  {inquiryCounts.waiting > 0 && (
                    <span title={T.task.drawer.inquiryWaitingTip(inquiryCounts.waiting)}
                          className="rounded bg-blue-100 px-1 text-[11px] font-medium text-blue-700
                                     dark:bg-blue-500/15 dark:text-blue-300">
                      {T.task.drawer.inquiryWaiting(inquiryCounts.waiting)}
                    </span>
                  )}
                  {inquiryCounts.overdue > 0 && (
                    <span title={T.task.drawer.inquiryOverdueTip(inquiryCounts.overdue)}
                          className="rounded bg-red-100 px-1 text-[11px] font-medium text-red-700
                                     dark:bg-red-500/15 dark:text-red-300">
                      {T.task.drawer.inquiryOverdue(inquiryCounts.overdue)}
                    </span>
                  )}
                  {inquiryCounts.allReplied && (
                    <span className="rounded bg-emerald-100 px-1.5 text-[11px] font-medium
                                     text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                      {T.task.drawer.inquiryAllReplied}
                    </span>
                  )}
                </div>
                {canEdit ? (
                  <TitleBox
                    value={form.title}
                    onCommit={v => v !== form.title && edit({ title: v })}
                  />
                ) : (
                  /* 改不動就不要畫成輸入框 —— 看起來能打字卻存不進去最難懂 */
                  <h2 className="mt-1.5 text-xl font-semibold text-slate-800 dark:text-slate-100">
                    {data.title}
                  </h2>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/*
                  * 保存與刪除放在標題列右邊，不放在整頁最下面 ——
                  * 這一頁很長（欄位、問題、對外詢問、關聯、活動紀錄），
                  * 按鈕擺在底下的話，改完上面那排欄位還要先捲到最後才存得了。
                  */}
                {canEdit && (
                  <Button
                    variant="primary"
                    disabled={!dirty || save.isPending || saveBlocked}
                    title={saveBlocked
                      ? T.task.drawer.saveBlockedByInquiry(openInquiries)
                      : (!dirty ? T.task.drawer.nothingToSave : undefined)}
                    onClick={() => save.mutate(draft as Record<string, unknown>)}>
                    {save.isPending ? T.task.drawer.saving : T.task.drawer.save}
                  </Button>
                )}
                {canEdit && dirty && (
                  <Button onClick={() => setDraft({})}>{T.task.drawer.discard}</Button>
                )}

                {/* 刪除兩段式：按一次問一句，再按一次才真的刪。
                    不用瀏覽器的 confirm —— 那會擋住整個分頁 */}
                {canEdit && (confirmDelete ? (
                  <>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {(data.children?.length ?? 0) > 0
                        ? T.task.drawer.deleteHasChildren(data.children.length)
                        : T.task.drawer.deleteConfirm}
                    </span>
                    <Button variant="danger" disabled={remove.isPending}
                            onClick={() => remove.mutate()}>
                      {T.task.drawer.deleteYes}
                    </Button>
                    <Button onClick={() => setConfirmDelete(false)}>{T.common.cancel}</Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                    {T.task.drawer.delete}
                  </Button>
                ))}

                <Button variant="ghost" onClick={onClose} className="text-lg leading-none">✕</Button>
              </div>
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
                *
                * 格線是**六欄**不是四欄。四欄的話進度與日期各佔兩欄就把第二列填滿，
                * 排程模式被擠到第三列自己一個人站著 —— 那一列看起來像是後來
                * 補上去的東西，而它只是眾多欄位裡的一個。
                */}
              {/*
                * 「做完了」那幾個狀態還在清單上，只是選不動（`disabled`）——
                * 整個抽掉的話，看的人不知道那些狀態跑哪去了，
                * 灰掉才看得出來「有這個選項，但現在不行」。
                *
                * 說明放在整排欄位**上面一整行**，不放在狀態那一格底下：
                * 那一格只有六分之一寬，一句話會被擠成三、四行，
                * 把整排欄位撐開。
                */}
              {canEdit && openInquiries > 0 && (
                <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed
                              text-amber-700 ring-1 ring-inset ring-amber-600/20
                              dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30">
                  {T.task.drawer.statusBlockedByInquiry(openInquiries)}
                </p>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
                <Field label={T.task.drawer.fieldTaskType}>
                  {canEdit ? (
                    /*
                     * 能改成哪幾種，要同時看**上層是誰**與**底下掛了什麼**：
                     * 大項目不能放在任務底下；底下還掛著問題的話，自己就不能
                     * 從任務變成別的（問題的上層一定要是任務）。
                     * 判斷在 lib/hierarchy.ts，後端有同一份守門員。
                     */
                    <Select value={form.type}
                            onChange={e => edit({ type: e.target.value as TaskDetail['type'] })}
                            className="w-full">
                      {typeChoices.map(t => (
                        <option key={t.key} value={t.key}>{t.name}</option>
                      ))}
                    </Select>
                  ) : (
                    <ReadOnlyValue>{typeOf(form.type) || form.type}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldStatus}>
                  {canEdit ? (
                    /*
                     * 還有對外詢問沒回的時候，「算是做完了」那幾個狀態不畫出來
                     * （規矩見 AGENTS.md；後端也擋，這裡只是不要畫出按了會被拒絕的選項）。
                     * 目前這一個永遠留著 —— 既有資料可能本來就違反，
                     * 拿掉的話下拉會顯示成別的狀態，然後一存檔就靜悄悄改掉它。
                     */
                    <Select value={form.statusKey}
                            onChange={e => edit({ statusKey: e.target.value })}
                            className="w-full">
                      {statuses.map(s => (
                        <option key={s.key} value={s.key}
                                disabled={openInquiries > 0 && s.category === 'DONE'
                                          && s.key !== data.statusKey}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <ReadOnlyValue>
                      {statuses.find(s => s.key === form.statusKey)?.name ?? T.common.none}
                    </ReadOnlyValue>
                  )}
                </Field>
                <div className="sm:col-span-2">
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
                </div>
                <Field label={T.task.drawer.fieldPriority}>
                  {canEdit ? (
                    <Select value={form.priority}
                            onChange={e => edit({ priority: e.target.value as TaskDetail['priority'] })}
                            className="w-full">
                      {priorities.map(p => (
                        <option key={p.key} value={p.key}>{p.name}</option>
                      ))}
                    </Select>
                  ) : (
                    <ReadOnlyValue>{priorityOf(form.priority)}</ReadOnlyValue>
                  )}
                </Field>
                <Field label={T.task.drawer.fieldScheduleMode}>
                  {canEdit ? (
                    <Select value={form.scheduleMode}
                            onChange={e => edit({ scheduleMode: e.target.value as TaskDetail['scheduleMode'] })}
                            className="w-full">
                      <option value="AUTO">{T.task.drawer.scheduleAuto}</option>
                      <option value="MANUAL">{T.task.drawer.scheduleManual}</option>
                    </Select>
                  ) : (
                    <ReadOnlyValue>
                      {form.scheduleMode === 'AUTO'
                        ? T.task.drawer.scheduleAuto
                        : T.task.drawer.scheduleManual}
                    </ReadOnlyValue>
                  )}
                </Field>
                {/* 進度佔兩欄：拖拉條再窄就拖不準了 */}
                <div className="sm:col-span-2">
                  <Field label={T.task.drawer.fieldProgress}>
                    {canEdit ? (
                      <ProgressField value={form.progress}
                                     onCommit={v => edit({ progress: v })} />
                    ) : (
                      <ReadOnlyValue>{T.task.drawer.progressValue(form.progress)}</ReadOnlyValue>
                    )}
                  </Field>
                </div>
                {/* 開始與結束擺在同一格，中間一個破折號 —— 它們是一段期間，不是兩個欄位 */}
                <div className="sm:col-span-4">
                  <Field label={`${T.task.drawer.fieldStart} – ${T.task.drawer.fieldDue}`}>
                    {canEdit ? (
                      <div className="flex items-center gap-2">
                        <Input type="date" className="min-w-0 flex-1"
                               value={form.startDate?.slice(0, 10) ?? ''}
                               aria-label={T.task.drawer.fieldStart}
                               onChange={e => edit({ startDate: e.target.value || null })} />
                        <span aria-hidden className="text-slate-400 dark:text-slate-400">–</span>
                        <Input type="date" className="min-w-0 flex-1"
                               value={form.dueDate?.slice(0, 10) ?? ''}
                               aria-label={T.task.drawer.fieldDue}
                               onChange={e => edit({ dueDate: e.target.value || null })} />
                      </div>
                    ) : (
                      <ReadOnlyValue>
                        {fmtDate(form.startDate)} – {fmtDate(form.dueDate)}
                      </ReadOnlyValue>
                    )}
                  </Field>
                </div>
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
 * 任務標題。**會自己長高，不是單行輸入框。**
 *
 * 原本是 `<input>`：一行放不下的標題不會換行，只是往旁邊捲出去 ——
 * 「外部系統自動建立的任務（API 權杖測試）」在畫面上被切成
 * 「外部系統自動建立的任務（API 檔」，而且看不出來後面還有字。
 * 標題是最不該被截斷的東西。
 *
 * 用 `<textarea>` 而不是加 `title=`：滑過去才看得到全文，等於要求他先發現
 * 有東西被藏起來。改成看得到全部，框自己長。
 * 按 Enter 不換行 —— 標題是一句話，換行只會把版面撐開又存不進意義。
 */
function TitleBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  /** 開始編輯時把游標放到最後面，而不是選起來 —— 多半是要接著打，不是整句重寫 */
  useEffect(() => {
    const el = ref.current
    if (!editing || !el) return
    fit()
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  /** 高度跟著內容長。標題是最不該被截斷的東西，所以不捲、直接長高 */
  const fit = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  const base = 'mt-1.5 w-full text-xl font-semibold leading-snug text-slate-800 dark:text-slate-100'

  if (!editing) {
    /*
     * 平常就是一行字，點一下才變輸入框。
     *
     * 原本一進來就是輸入框（只是長得像文字）—— 那讓「看」跟「改」分不出來：
     * 想選字複製會不小心改到，而真的要改的人也看不出來這裡能改。
     * 用 button 不用 div：鍵盤 Tab 得到、Enter 也進得去。
     */
    return (
      <button type="button" onClick={() => setEditing(true)} title={T.task.drawer.editTitle}
              className={cx(base, 'block rounded text-left hover:bg-slate-100',
                            'dark:hover:bg-slate-800')}>
        {value}
      </button>
    )
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      defaultValue={value}
      onInput={fit}
      onKeyDown={e => {
        // Enter 存檔（標題是一句話，不需要換行）；Esc 放棄這次的修改
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
        if (e.key === 'Escape') { e.currentTarget.value = value; e.currentTarget.blur() }
      }}
      onBlur={e => { setEditing(false); onCommit(e.target.value.trim()) }}
      className={cx(base, 'resize-none overflow-hidden rounded border-0 bg-transparent p-0',
                    'focus:outline-none focus:ring-0')}
    />
  )
}

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
  // useId 產出的字串帶冒號，當 HTML id 用要先換掉
  const ticksId = `ticks-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
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
        type="range" min={0} max={100} step={10} list={ticksId} value={draft}
        aria-label={T.task.drawer.progressAria}
        onPointerDown={() => { dragging.current = true }}
        onChange={e => setDraft(Number(e.target.value))}
        onPointerUp={e => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={e => commit(Number((e.target as HTMLInputElement).value))}
        onBlur={() => commit(draft)}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full
                   bg-slate-200 accent-blue-600 dark:bg-slate-700 dark:accent-blue-500"
      />
      {/* 十格刻度。拖的時候會吸附到整十，也看得出來現在大概在第幾格 ——
          沒有刻度的話 40% 跟 45% 在畫面上分不出來，而那兩個數字沒有差別到
          需要分辨的程度（進度本來就是概數） */}
      <datalist id={ticksId}>
        {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => (
          <option key={v} value={v} />
        ))}
      </datalist>

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
