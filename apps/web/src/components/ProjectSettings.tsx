import { useState, type ReactNode } from 'react'
import {
  DndContext, PointerSensor, KeyboardSensor,
  useSensor, useSensors, closestCorners,
  type Announcements, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type ParamKind, type ProjectParam } from '../lib/api'
import { Button, Empty, Field, Input, Select, Spinner, cx } from './ui'
import { T } from '../strings'

/**
 * 這個專案自己的系統參數：任務狀態、優先度、任務類型。
 *
 * **重點是「每個專案改自己的」。** 狀態欄本來就是這樣，優先度與任務類型
 * 原本寫死在資料表裡，現在也跟著變成每個專案一份 —— 蓋房子的專案要
 * 「圖說審查中」，辦活動的專案要「等廠商報價」，共用一套只會逼所有人
 * 遷就別人的流程。
 *
 * 三種參數長得一模一樣（名稱、顏色、順序），所以畫面也只寫一份，
 * 用 kind 分三區。狀態多一個「算不算做完了」，那是它專屬的。
 *
 * 順序用拖的：每一列最前面有一個握把，拖曳與看板同一套 dnd-kit。
 * **三份清單各自是一個 DndContext**，優先度不可能被拖進狀態那一組 ——
 * 那三份是不同的東西，混在一起只會拖出髒資料。
 * 上下箭頭沒有拿掉：拖曳對觸控筆、手抖的人、只用鍵盤的人都不是最省力的路，
 * 箭頭是那條保底的路（鍵盤本身走 KeyboardSensor 也能拖，兩條都留著）。
 *
 * 最上面另外有一個「專案代碼」區塊，那是專案本身的欄位，不是三份清單之一 ——
 * 但要改它的人就是會來這一頁找，所以擺在一起。
 *
 * 有一件事刻意不做：
 *  - **參數的代碼（key）不給改。** 任務是靠它指回來的，改了等於把既有任務
 *    指向不存在的值。畫面上連看都不給看 —— 那是程式用的東西，擺出來只會有人想動它。
 *    專案代碼是另一回事：任務編號是查詢時拼出來的，改了會整批跟著換，不會壞掉。
 *
 * 所有按鈕都掛在後端回的 canManage 底下，跟成員頁同一個做法。
 */

const S = T.settings

/** 三區的順序就是畫面由上往下的順序。狀態最常改，放第一個 */
const SECTIONS: Array<{ kind: ParamKind; title: string; hint: string }> = [
  { kind: 'status', title: S.sections.status.title, hint: S.sections.status.hint },
  { kind: 'priority', title: S.sections.priority.title, hint: S.sections.priority.hint },
  { kind: 'type', title: S.sections.type.title, hint: S.sections.type.hint },
]

const CATEGORIES = ['TODO', 'ACTIVE', 'DONE'] as const

export default function ProjectSettings({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['projectParams', projectId],
    queryFn: () => Api.projectParams(projectId),
  })

  const canManage = !!data?.canManage
  const params = data?.params ?? []

  /**
   * 參數改了，任務畫面上的下拉與徽章跟著要換一份 ——
   * 專案（statuses/priorities/types）與任務清單都要重抓。
   */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['projectParams', projectId] })
    qc.invalidateQueries({ queryKey: ['project', projectId] })
    qc.invalidateQueries({ queryKey: ['tasks', projectId] })
  }
  const fail = (e: unknown) => setErr(
    e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : S.saveFailed
  )
  const ok = () => { setErr(null); refresh() }

  const patch = useMutation({
    mutationFn: (v: {
      id: string
      body: {
        name?: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE'
        beforeId?: string | null; afterId?: string | null
      }
    }) => Api.patchProjectParam(projectId, v.id, v.body),
    onSuccess: ok, onError: fail,
  })

  /**
   * 換順序自己走一條，因為它要**樂觀更新** —— 放手的瞬間就換位置，
   * 等網路回來才動的話，那一列會彈回原位再跳過去，看起來像沒拖成功。
   * 失敗才把整份快取換回去（跟看板的拖曳同一套協定）。
   */
  const reorder = useMutation({
    mutationFn: (v: {
      id: string
      kind: ParamKind
      /** 這一區換完之後的完整順序，樂觀更新直接照它排 */
      orderedIds: string[]
      body: { beforeId?: string | null; afterId?: string | null }
    }) => Api.patchProjectParam(projectId, v.id, v.body),
    onMutate: async v => {
      await qc.cancelQueries({ queryKey: ['projectParams', projectId] })
      const prev = qc.getQueryData(['projectParams', projectId])
      qc.setQueryData(
        ['projectParams', projectId],
        (old: { params: ProjectParam[]; canManage: boolean } | undefined) => {
          if (!old) return old
          const byId = new Map(old.params.map(p => [p.id, p]))
          const sorted = v.orderedIds.map(id => byId.get(id)).filter(Boolean) as ProjectParam[]
          // 別人剛好在同一秒新增或刪除，手上的順序就對不上了 ——
          // 這種時候什麼都不動，等後端回來的那一份才算數
          if (sorted.length !== v.orderedIds.length) return old
          if (old.params.filter(p => p.kind === v.kind).length !== sorted.length) return old
          // 只重排這一區，其他兩區原地不動：照原本的位置一個一個填回去
          let i = 0
          return { ...old, params: old.params.map(p => (p.kind === v.kind ? sorted[i++] : p)) }
        },
      )
      return { prev }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['projectParams', projectId], ctx.prev)
      fail(e)
    },
    onSettled: () => { refresh() },
  })

  const create = useMutation({
    mutationFn: (v: {
      kind: ParamKind; name: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE'
    }) => Api.createProjectParam(projectId, v),
    onSuccess: ok, onError: fail,
  })

  const remove = useMutation({
    mutationFn: (v: { id: string; moveTo?: string }) =>
      Api.deleteProjectParam(projectId, v.id, v.moveTo),
    onSuccess: ok, onError: fail,
  })

  if (isLoading) return <Spinner label={S.loading} />

  return (
    <div className="h-full overflow-auto bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-3xl px-6 py-8">

        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{S.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{S.intro}</p>
        {!canManage && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">{S.readonlyHint}</p>
        )}

        {err && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50
                          px-3 py-2 text-sm text-red-700
                          dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
            <span className="flex-1">{err}</span>
            <button onClick={() => setErr(null)}
                    className="text-red-400 hover:text-red-600 dark:hover:text-red-200">✕</button>
          </div>
        )}

        {/* 專案代碼擺在三份清單之前：它是整頁最上層的東西（任務編號的開頭），
            而且只有能管這個專案的人動得了 */}
        {canManage && <ProjectKeySection projectId={projectId} />}

        {SECTIONS.map(sec => (
          <Section
            key={sec.kind}
            kind={sec.kind}
            title={sec.title}
            hint={sec.hint}
            rows={params.filter(p => p.kind === sec.kind)}
            canManage={canManage}
            busy={patch.isPending || create.isPending || remove.isPending}
            onPatch={(id, body) => patch.mutate({ id, body })}
            onReorder={(id, orderedIds, body) =>
              reorder.mutate({ id, kind: sec.kind, orderedIds, body })}
            onCreate={v => create.mutate({ kind: sec.kind, ...v })}
            onRemove={(id, moveTo) => remove.mutate({ id, moveTo })}
          />
        ))}

      </div>
    </div>
  )
}

const K = S.projectKey

/** 跟後端 createBody 的正則同一份（api/src/routes/projects.ts）。兩邊都擋，訊息才講得出是哪裡不對 */
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

/**
 * 專案代碼＝任務編號的前綴（`MRG-2` 的 MRG）。
 *
 * 改得動是因為**任務編號沒有存成欄位**：後端每次都用 `p.key || '-' || t.number`
 * 拼出來，所以代碼一改，舊任務的編號立刻跟著換，不需要回填任何資料。
 * 反過來說，抄在信件、報告裡的舊編號就對不上了 —— 所以 warning 那句話
 * **貼著按鈕放**，不能藏在游標停著才看得到的地方：按下去就回不來了。
 */
function ProjectKeySection({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => Api.project(projectId),
  })

  const [key, setKey] = useState('')
  // 專案資料回來（或別人改過）之後，把輸入框對回伺服器上的那一份
  // ——「render 期間依變化調整 state」，跟上面 Row 改名字同一個做法
  const [seen, setSeen] = useState<string | null>(null)
  const current = project?.key ?? null
  if (current !== null && current !== seen) { setSeen(current); setKey(current) }

  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: string) => Api.patchProject(projectId, { key: v }),
    onSuccess: () => {
      setErr(null)
      setDone(true)
      // 編號在很多份快取裡已經是拼好的字串，代碼換了就全部過期：
      // 專案清單（選專案頁）、這個專案本身、以及任務清單裡的 ref
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
    onError: e => {
      setDone(false)
      // 格式在送出前就擋掉了，所以後端這時候回 400／409 只可能是撞號
      // （見 routes/projects.ts 的重複檢查）。其餘一律當成沒存成功。
      setErr(e instanceof ApiError && (e.status === 400 || e.status === 409)
        ? K.duplicate : K.failed)
    },
  })

  const invalid = key.length > 0 && !KEY_RE.test(key)
  const changed = current !== null && key !== current
  const submit = () => {
    if (!changed || !KEY_RE.test(key)) return
    save.mutate(key)
  }

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{K.title}</h2>
      <p className="mb-2 mt-0.5 text-xs text-slate-500 dark:text-slate-400">{K.hint}</p>

      <div className="rounded-xl bg-white px-4 py-3 ring-1 ring-slate-200
                      dark:bg-slate-900 dark:ring-slate-700">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={K.label}>
            <Input
              value={key}
              // 代碼一律大寫，讓他自己按 Shift 只會換來一個「格式不對」
              onChange={e => { setKey(e.target.value.toUpperCase()); setDone(false); setErr(null) }}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              placeholder={K.placeholder}
              disabled={save.isPending}
              aria-invalid={invalid}
              className="w-40 font-mono tracking-wider"
            />
          </Field>
          <Button
            variant="primary"
            disabled={save.isPending || !changed || invalid || !key}
            onClick={submit}>
            {K.save}
          </Button>
        </div>

        <p className="mt-1 text-xs text-slate-400 dark:text-slate-400">{K.rule}</p>

        {/* 按下去之前一定要看到這句：所有任務的編號都會跟著換 */}
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800
                      dark:bg-amber-500/10 dark:text-amber-300">
          {K.warning}
        </p>

        {invalid && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{K.invalid}</p>
        )}
        {err && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{err}</p>}
        {done && !changed && (
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{K.saved}</p>
        )}
      </div>
    </section>
  )
}

function Section({
  kind, title, hint, rows, canManage, busy, onPatch, onReorder, onCreate, onRemove,
}: {
  kind: ParamKind
  title: string
  hint: string
  rows: ProjectParam[]
  canManage: boolean
  busy: boolean
  onPatch: (id: string, body: {
    name?: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE'
  }) => void
  /** 換順序：誰、換完之後這一區的完整順序、送給後端的兩個鄰居 */
  onReorder: (
    id: string,
    orderedIds: string[],
    body: { beforeId?: string | null; afterId?: string | null },
  ) => void
  onCreate: (v: { name: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE' }) => void
  onRemove: (id: string, moveTo?: string) => void
}) {
  /** 正在問「那些任務改成哪一個」的是哪一列；null＝沒有人在刪 */
  const [removing, setRemoving] = useState<string | null>(null)

  const sensors = useSensors(
    // 要拖 6px 才算開始拖，否則單純點擊會被誤判（跟看板同一個門檻）
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // 鍵盤操作路徑：拖曳功能必須有非滑鼠的替代方式
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  /**
   * 換順序。afterId 是「我排在誰後面」，beforeId 是「我排在誰前面」，
   * 兩邊的鄰居都給，後端才算得出中間的位置（跟卡片拖曳同一套）。
   * 拖曳與上下箭頭走的是同一條，差別只在 to 怎麼算出來。
   */
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= rows.length) return
    const next = arrayMove(rows, from, to)
    onReorder(rows[from].id, next.map(r => r.id), {
      afterId: next[to - 1]?.id ?? null,
      beforeId: next[to + 1]?.id ?? null,
    })
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    move(rows.findIndex(r => r.id === active.id), rows.findIndex(r => r.id === over.id))
  }

  /** 讀螢幕軟體聽到的四句話。套件預設是英文，所以整組換掉 */
  const nameOf = (id: string | number) => rows.find(r => r.id === id)?.name ?? ''
  const posOf = (id: string | number) => rows.findIndex(r => r.id === id) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      S.reorder.picked(nameOf(active.id), posOf(active.id), rows.length),
    onDragOver: ({ active, over }) =>
      over ? S.reorder.moved(nameOf(active.id), posOf(over.id), rows.length) : undefined,
    onDragEnd: ({ active, over }) =>
      over ? S.reorder.dropped(nameOf(active.id), posOf(over.id), rows.length) : undefined,
    onDragCancel: ({ active }) => S.reorder.cancelled(nameOf(active.id)),
  }

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{title}</h2>
      <div className="mb-2">
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
        {/* 順序怎麼調要講出來 —— 握把是個圖案，不講沒有人知道它可以拖，也不知道鍵盤怎麼走 */}
        {canManage && rows.length > 1 && (
          <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-400">{S.reorder.hint}</p>
        )}
      </div>

      {rows.length === 0 ? (
        <Empty>{S.empty}</Empty>
      ) : (
        /* 一區一個 DndContext：拖曳的範圍就只有這一區，跨不到另外兩份清單 */
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions: { draggable: S.reorder.instructions } }}>
          <SortableContext items={rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200
                            dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-700">
              {rows.map((p, i) => (
                <SortableRow
                  key={p.id}
                  id={p.id}
                  disabled={!canManage || busy}
                  handleLabel={S.reorder.handle(p.name)}>
                  {handle => (
                    <>
                      <Row
                        param={p}
                        kind={kind}
                        canManage={canManage}
                        busy={busy}
                        handle={handle}
                        isFirst={i === 0}
                        isLast={i === rows.length - 1}
                        isOnlyOne={rows.length === 1}
                        onPatch={body => onPatch(p.id, body)}
                        onMoveUp={() => move(i, i - 1)}
                        onMoveDown={() => move(i, i + 1)}
                        onAskRemove={() => setRemoving(p.id)}
                        onRemove={() => onRemove(p.id)}
                      />
                      {removing === p.id && p.inUse > 0 && (
                        <RemoveWithMove
                          param={p}
                          others={rows.filter(o => o.id !== p.id)}
                          busy={busy}
                          onCancel={() => setRemoving(null)}
                          onConfirm={moveTo => { setRemoving(null); onRemove(p.id, moveTo) }}
                        />
                      )}
                    </>
                  )}
                </SortableRow>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {canManage && <AddRow kind={kind} title={title} busy={busy} onCreate={onCreate} />}
    </section>
  )
}

/**
 * 一列的拖曳外殼。**只有握把可以拖**，整列可拖的話會跟改名字的輸入框搶指標事件 ——
 * 想選字反而把整列拖走了。握把用 render prop 交給 Row 自己擺，
 * 拖曳的狀態（位移、抬起來的樣子）才留在這一層。
 */
function SortableRow({
  id, disabled, handleLabel, children,
}: {
  id: string
  disabled: boolean
  handleLabel: string
  children: (handle: ReactNode) => ReactNode
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({
    id,
    disabled,
    // 讀螢幕軟體念這一列時要講中文，不然套件預設會念出英文
    attributes: { roleDescription: S.reorder.roleDescription },
  })

  const handle = disabled ? null : (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      title={handleLabel}
      aria-label={handleLabel}
      className={cx(
        // touch-none：觸控時不要讓瀏覽器把手勢當成捲動
        'shrink-0 cursor-grab touch-none rounded px-1 py-1 text-sm leading-none transition-colors',
        'active:cursor-grabbing',
        'text-slate-400 hover:bg-slate-100 hover:text-slate-700',
        'dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200',
      )}>
      ⠿
    </button>
  )

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(
        // 拖起來的那一列要有自己的底色，不然會透出下面那一列
        'bg-white dark:bg-slate-900',
        isDragging && 'relative z-10 shadow-lg ring-1 ring-blue-400 dark:ring-blue-500',
      )}>
      {children(handle)}
    </div>
  )
}

function Row({
  param, kind, canManage, busy, handle, isFirst, isLast, isOnlyOne,
  onPatch, onMoveUp, onMoveDown, onAskRemove, onRemove,
}: {
  param: ProjectParam
  kind: ParamKind
  canManage: boolean
  busy: boolean
  /** 拖曳握把，由外面的 SortableRow 給 —— 不能管的人拿到的是 null */
  handle: ReactNode
  isFirst: boolean
  isLast: boolean
  isOnlyOne: boolean
  onPatch: (body: {
    name?: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE'
  }) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onAskRemove: () => void
  onRemove: () => void
}) {
  // 名稱在輸入框裡先自己記著，離開欄位（或按 Enter）才送出 ——
  // 每打一個字送一次的話，中文選字的過程會被一直打斷
  const [name, setName] = useState(param.name)
  // 別人改過同一列時，重抓回來的名稱要蓋掉輸入框裡的舊值
  // （這是 React 文件講的「render 期間依變化調整 state」，比 effect 少一次繪製）
  const [seenName, setSeenName] = useState(param.name)
  if (param.name !== seenName) { setSeenName(param.name); setName(param.name) }

  const commitName = () => {
    const v = name.trim()
    if (!v || v === param.name) { setName(param.name); return }
    onPatch({ name: v })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3">
      {handle}

      {/* 顏色是使用者自己挑的資料，不要套主題色 —— 這裡只負責讓他挑 */}
      <input
        type="color"
        aria-label={S.fields.color}
        value={param.color}
        disabled={!canManage || busy}
        onChange={e => onPatch({ color: e.target.value })}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-slate-300 bg-white
                   disabled:cursor-not-allowed
                   dark:border-slate-600 dark:bg-slate-900"
      />

      {canManage ? (
        <Input
          aria-label={S.fields.name}
          value={name}
          disabled={busy}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className="min-w-32 flex-1"
        />
      ) : (
        <span className="min-w-32 flex-1 text-sm text-slate-800 dark:text-slate-100">
          {param.name}
        </span>
      )}

      {/* 「算不算做完了」是狀態專屬的：優先度與類型沒有這個概念 */}
      {kind === 'status' && (
        <Select
          aria-label={S.fields.category}
          value={param.category ?? 'ACTIVE'}
          disabled={!canManage || busy}
          onChange={e => onPatch({ category: e.target.value as 'TODO' | 'ACTIVE' | 'DONE' })}>
          {CATEGORIES.map(c => <option key={c} value={c}>{S.category[c]}</option>)}
        </Select>
      )}

      <span className="w-32 shrink-0 text-right text-xs text-slate-400 dark:text-slate-400">
        {S.inUse(param.inUse)}
      </span>

      {canManage && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={S.moveUp} disabled={isFirst || busy} onClick={onMoveUp}>↑</IconButton>
          <IconButton label={S.moveDown} disabled={isLast || busy} onClick={onMoveDown}>↓</IconButton>
          <button
            title={isOnlyOne ? S.remove.lastOne : undefined}
            disabled={isOnlyOne || busy}
            onClick={() => {
              // 有人在用就先問「改成哪一個」，沒人在用才直接確認
              if (param.inUse > 0) onAskRemove()
              else if (window.confirm(S.remove.confirm(param.name))) onRemove()
            }}
            className="rounded px-2 py-1 text-xs text-slate-400 transition-colors
                       hover:bg-red-50 hover:text-red-600 disabled:opacity-40
                       disabled:hover:bg-transparent disabled:hover:text-slate-400
                       dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400">
            {S.remove.button}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 刪一個還有人在用的值：先問那些任務改成哪一個，按下去才一起做完。
 * 不給「直接刪」這個選項 —— 那會讓一批任務指向不存在的值，
 * 而且事後沒有人知道它們原本是什麼。
 */
function RemoveWithMove({
  param, others, busy, onCancel, onConfirm,
}: {
  param: ProjectParam
  others: ProjectParam[]
  busy: boolean
  onCancel: () => void
  onConfirm: (moveTo: string) => void
}) {
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '')

  return (
    <div className="border-t border-amber-200 bg-amber-50 px-4 py-3
                    dark:border-amber-500/30 dark:bg-amber-500/10">
      <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
        {S.remove.inUseTitle(param.name, param.inUse)}
      </div>
      <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{S.remove.inUseHint}</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Field label={S.remove.moveToLabel}>
          <Select value={moveTo} disabled={busy}
                  onChange={e => setMoveTo(e.target.value)}>
            {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
        <Button variant="danger" disabled={busy || !moveTo}
                onClick={() => onConfirm(moveTo)}>{S.remove.submit}</Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>{S.remove.cancel}</Button>
      </div>
    </div>
  )
}

/** 每一區最下面的新增列。新的一律排到最後面，順序由他自己調 */
function AddRow({
  kind, title, busy, onCreate,
}: {
  kind: ParamKind
  title: string
  busy: boolean
  onCreate: (v: { name: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE' }) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#94a3b8')
  const [category, setCategory] = useState<'TODO' | 'ACTIVE' | 'DONE'>('ACTIVE')

  const submit = () => {
    const v = name.trim()
    if (!v) return
    onCreate({ name: v, color, ...(kind === 'status' ? { category } : {}) })
    setName('')
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-white px-4 py-3 ring-1
                    ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
      <input
        type="color"
        aria-label={S.fields.color}
        value={color}
        disabled={busy}
        onChange={e => setColor(e.target.value)}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-slate-300 bg-white
                   dark:border-slate-600 dark:bg-slate-900"
      />
      <Input
        aria-label={S.add.title(title)}
        placeholder={S.add.placeholder(title)}
        value={name}
        disabled={busy}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }}
        className="min-w-32 flex-1"
      />
      {kind === 'status' && (
        <Select aria-label={S.fields.category} value={category} disabled={busy}
                onChange={e => setCategory(e.target.value as 'TODO' | 'ACTIVE' | 'DONE')}>
          {CATEGORIES.map(c => <option key={c} value={c}>{S.category[c]}</option>)}
        </Select>
      )}
      <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
        {S.add.submit}
      </Button>
    </div>
  )
}

function IconButton({
  label, disabled, onClick, children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'rounded px-1.5 py-1 text-sm transition-colors',
        'text-slate-400 hover:bg-slate-100 hover:text-slate-700',
        'disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400',
        'dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
      )}>
      {children}
    </button>
  )
}
