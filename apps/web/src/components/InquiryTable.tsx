import { useState, useRef, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Inquiry } from '../lib/api'
import { addMonthsYmd, addWorkingDaysYmd, parseYmd, todayYmd, toYmd, WEEKDAY_LABELS } from '../lib/date'
import { T } from '../strings'
import { Button, Input, cx } from './ui'

/**
 * 跨單位發文追蹤表格 —— 系統的核心元件。
 *
 * 設計要點：
 * 1. 提問側與回覆側是兩組獨立欄位。勾「回了沒」時自動帶入提問單位與今天，
 *    但兩個欄位都能改 ——「發文給資訊部、實際是委外廠商回」是常態。
 * 2. 單位是純自由文字（沒有主檔、不用先去設定裡新增），
 *    但輸入時會列出這個工作區用過的名稱當提示。
 * 3. 逾期天數是即時算的，不是存下來的欄位。
 * 4. 期望回覆日先選「幾個工作天後」，日期由系統算給人看（見 DueDateField）。
 */
export function InquiryTable({
  taskId, workspaceId, inquiries, canEdit,
}: {
  taskId: string; workspaceId: string; inquiries: Inquiry[]; canEdit: boolean
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [editingDueId, setEditingDueId] = useState<string | null>(null)

  // 站台設定的預設工作天數。整個工作階段都不會變，所以抓一次就好；
  // 抓不到時退回 7，跟後端環境變數的預設值同一個數字。
  const { data: settings } = useQuery({
    queryKey: ['inquiry-settings'],
    queryFn: () => Api.inquirySettings(),
    staleTime: Infinity,
  })
  const defaultDueDays = settings?.defaultDueDays ?? 7

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] })
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['inquiry-board'] })
  }

  const add = useMutation({
    mutationFn: (v: Record<string, unknown>) => Api.addInquiry(taskId, v),
    onSuccess: () => { setAdding(false); invalidate() },
  })
  const reply = useMutation({
    mutationFn: ({ id, v }: { id: string; v: Record<string, unknown> }) => Api.markReplied(id, v),
    onSuccess: () => { setReplyingId(null); invalidate() },
  })
  const reopen = useMutation({
    mutationFn: (id: string) => Api.reopenInquiry(id), onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => Api.deleteInquiry(id), onSuccess: invalidate,
  })
  const changeDue = useMutation({
    mutationFn: ({ id, dueDate }: { id: string; dueDate: string | null }) =>
      Api.patchInquiry(id, { dueDate }),
    onSuccess: () => { setEditingDueId(null); invalidate() },
  })

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          {T.inquiry.table.title}
        </h3>
        {canEdit && !adding && (
          <Button onClick={() => setAdding(true)} className="text-xs">{T.inquiry.table.add}</Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200 dark:ring-slate-700">
        <table className="w-full min-w-[900px] border-collapse bg-white text-sm dark:bg-slate-900">
          <thead>
            <tr className="bg-slate-50 text-left text-xs font-medium text-slate-500
                           dark:bg-slate-800 dark:text-slate-400">
              <th className="px-3 py-2">{T.inquiry.table.column.askedToUnit}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.askedToPerson}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.contact}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.askedAt}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.dueDate}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.status}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.repliedByUnit}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.repliedByPerson}</th>
              <th className="px-3 py-2">{T.inquiry.table.column.repliedAt}</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {inquiries.length === 0 && !adding && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400 dark:text-slate-400">
                {T.inquiry.table.empty}
              </td></tr>
            )}

            {inquiries.map(q => {
              const transferred = q.isReplied && q.repliedByUnit && q.repliedByUnit !== q.askedToUnit
              return (
                <tr key={q.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-800 dark:text-slate-100">{q.askedToUnit}</td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{q.askedToPerson ?? T.common.none}</td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{q.askedToContact ?? T.common.none}</td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{fmt(q.askedAt)}</td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                    {editingDueId === q.id ? (
                      <DueDateEditor
                        inquiry={q}
                        busy={changeDue.isPending}
                        onCancel={() => setEditingDueId(null)}
                        onSubmit={dueDate => changeDue.mutate({ id: q.id, dueDate })}
                      />
                    ) : canEdit ? (
                      <button
                        type="button"
                        title={T.inquiry.table.editDue}
                        className="-mx-1 rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-700
                                   dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        onClick={() => setEditingDueId(q.id)}
                      >
                        {fmt(q.dueDate)}
                      </button>
                    ) : fmt(q.dueDate)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2"><StatusCell q={q} /></td>
                  <td className={cx('px-3 py-2', transferred
                    ? 'font-medium text-amber-700 dark:text-amber-300'
                    : 'text-slate-600 dark:text-slate-300')}>
                    {q.repliedByUnit ?? T.common.none}
                    {transferred && (
                      <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                        {T.inquiry.table.transferred}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{q.repliedByPerson ?? T.common.none}</td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{fmt(q.repliedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {canEdit && (q.isReplied
                      ? <Button variant="ghost" className="text-xs" onClick={() => reopen.mutate(q.id)}>{T.inquiry.table.reopen}</Button>
                      : <Button variant="primary" className="text-xs" onClick={() => setReplyingId(q.id)}>{T.inquiry.table.markReplied}</Button>)}
                    {canEdit && (
                      <Button variant="ghost" className="ml-1 text-xs text-slate-400 dark:text-slate-400"
                              onClick={() => remove.mutate(q.id)} title={T.common.delete}>✕</Button>
                    )}
                  </td>
                </tr>
              )
            })}

            {replyingId && (
              <ReplyRow
                inquiry={inquiries.find(i => i.id === replyingId)!}
                workspaceId={workspaceId}
                onCancel={() => setReplyingId(null)}
                onSubmit={v => reply.mutate({ id: replyingId, v })}
                busy={reply.isPending}
              />
            )}

            {adding && (
              <AskRow
                workspaceId={workspaceId}
                defaultDueDays={defaultDueDays}
                onCancel={() => setAdding(false)}
                onSubmit={v => add.mutate(v)}
                busy={add.isPending}
              />
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusCell({ q }: { q: Inquiry }) {
  if (q.status === 'REPLIED') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-50 px-1.5 py-0.5
                       text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20
                       dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30">
        <span aria-hidden>✓</span>{T.inquiry.table.status.replied}
        {q.daysToReply != null && (
          <span className="text-emerald-600/70 dark:text-emerald-400/80">
            {T.inquiry.table.status.repliedDays(q.daysToReply)}
          </span>
        )}
      </span>
    )
  }
  if (q.status === 'OVERDUE') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-red-50 px-1.5 py-0.5
                       text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20
                       dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30">
        {/* 逾期天數由後端算，狀態是 OVERDUE 就一定有值；?? 0 只是讓型別過關 */}
        <span aria-hidden>⚠️</span>{T.inquiry.overdueDays(q.daysOverdue ?? 0)}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-50 px-1.5 py-0.5
                     text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20
                     dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/30">
      <span aria-hidden>⏳</span>{T.inquiry.elapsedDays(q.daysElapsed)}
    </span>
  )
}

/** 新增一筆詢問單 */
function AskRow({
  workspaceId, defaultDueDays, onCancel, onSubmit, busy,
}: {
  workspaceId: string
  defaultDueDays: number
  onCancel: () => void
  onSubmit: (v: Record<string, unknown>) => void
  busy: boolean
}) {
  const [unit, setUnit] = useState('')
  const [person, setPerson] = useState('')
  const [contact, setContact] = useState('')
  const [question, setQuestion] = useState('')
  // 提問日就是今天（後端也是這樣填），所以「幾天後」一律從今天起算
  const base = todayYmd()
  const due = useDueDate(base, () => defaultDue(base, defaultDueDays))

  return (
    <tr className="border-t-2 border-blue-200 bg-blue-50/40 dark:border-blue-500/40 dark:bg-blue-500/10">
      <td className="px-2 py-2">
        <UnitInput workspaceId={workspaceId} value={unit} onChange={setUnit}
                   placeholder={T.inquiry.table.placeholder.unit} autoFocus />
      </td>
      <td className="px-2 py-2"><Input value={person} onChange={e => setPerson(e.target.value)} placeholder={T.inquiry.table.placeholder.person} /></td>
      <td className="px-2 py-2"><Input value={contact} onChange={e => setContact(e.target.value)} placeholder={T.inquiry.table.placeholder.contact} /></td>
      <td className="px-2 py-2 text-xs text-slate-400 dark:text-slate-400">{T.inquiry.table.askedToday}</td>
      <td className="px-2 py-2 align-top">
        <DueDateField state={due} />
      </td>
      <td colSpan={4} className="px-2 py-2">
        <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder={T.inquiry.table.placeholder.question} />
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right">
        <Button variant="primary" className="text-xs" disabled={!unit.trim() || busy}
                onClick={() => onSubmit({
                  askedToUnit: unit.trim(),
                  askedToPerson: person.trim() || undefined,
                  askedToContact: contact.trim() || undefined,
                  // 一律送明確的值：空字串代表「不設期限」，要送 null 讓後端別再套預設
                  dueDate: due.date || null,
                  question: question.trim() || undefined,
                })}>{T.common.save}</Button>
        <Button variant="ghost" className="ml-1 text-xs" onClick={onCancel}>{T.common.cancel}</Button>
      </td>
    </tr>
  )
}

// ── 期望回覆日 ─────────────────────────────────────────

/**
 * 「幾天後回覆」的選項。
 *
 * 只給一個日期欄位的話，使用者得自己翻月曆算「三個工作天是幾號」，
 * 多數人乾脆隨手挑一天，逾期統計跟著失真。這裡把常用的幾檔先算好，
 * 從「很急」一路到「一個月」都有；算出來的日期仍然落在日期欄位裡，
 * 特殊狀況照樣可以自己改。
 *
 * 工作天一律走 lib/date.ts 的 addWorkingDaysYmd —— 跟後端同一套算法，
 * 畫面上看到的那一天就是存進資料庫的那一天。
 *
 * 這張表只管日期怎麼算，標籤在 strings/inquiry.ts 的 due.preset ——
 * 改字的人不必看懂工作天邏輯。
 */
type DuePresetKey = keyof typeof T.inquiry.due.preset

const DUE_PRESETS: Array<{
  key: DuePresetKey; workingDays?: number; months?: number
}> = [
  { key: 'D1',     workingDays: 1 },
  { key: 'D3',     workingDays: 3 },
  { key: 'D5',     workingDays: 5 },
  { key: 'D7',     workingDays: 7 },
  { key: 'D10',    workingDays: 10 },
  { key: 'D14',    workingDays: 14 },
  { key: 'M1',     months: 1 },
  { key: 'NONE' },
  { key: 'CUSTOM' },
]

/** 某一檔選項從起算日推出來的日期。不設期限沒有日期，自訂日期由呼叫端沿用原值 */
function presetDate(key: DuePresetKey, base: string): string {
  const p = DUE_PRESETS.find(x => x.key === key)
  if (p?.workingDays != null) return addWorkingDaysYmd(base, p.workingDays)
  if (p?.months != null) return addMonthsYmd(base, p.months)
  return ''
}

/**
 * 站台預設的工作天數對應到哪一檔。
 * 站台把天數設成清單裡沒有的值時退回「自訂日期」，但日期照樣算出來 ——
 * 預設值是什麼，畫面上就要看得到那一天。
 */
function defaultDue(base: string, defaultDays: number): { preset: DuePresetKey; date: string } {
  if (defaultDays <= 0) return { preset: 'NONE', date: '' }
  const hit = DUE_PRESETS.find(p => p.workingDays === defaultDays)
  return hit
    ? { preset: hit.key, date: presetDate(hit.key, base) }
    : { preset: 'CUSTOM', date: addWorkingDaysYmd(base, defaultDays) }
}

/** 選項與日期綁成同一份狀態，兩邊才不會各說各話 */
function useDueDate(base: string, init: () => { preset: DuePresetKey; date: string }) {
  const [{ preset, date }, set] = useState(init)
  return {
    preset, date,
    /** 選了某一檔就把日期算出來；選「自訂日期」則沿用目前這一天讓人自己改 */
    choose: (key: DuePresetKey) =>
      set(s => ({ preset: key, date: key === 'CUSTOM' ? s.date : presetDate(key, base) })),
    /** 手動改日期就退回「自訂日期」；清空等於不設期限 */
    setDate: (v: string) => set({ preset: v ? 'CUSTOM' : 'NONE', date: v }),
  }
}

function DueDateField({ state }: { state: ReturnType<typeof useDueDate> }) {
  return (
    <div className="space-y-1">
      {/* 原生 select 的底色不吃 Tailwind 的預設，深色底下得自己指定，
          不然是白底黑字的一塊 */}
      <select
        value={state.preset}
        onChange={e => state.choose(e.target.value as DuePresetKey)}
        aria-label={T.inquiry.due.label}
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs
                   focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40
                   dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
      >
        {DUE_PRESETS.map(p => (
          <option key={p.key} value={p.key}>{T.inquiry.due.preset[p.key]}</option>
        ))}
      </select>
      {/* color-scheme 決定日期選擇器那顆小日曆的長相，只給背景色它還是白的 */}
      <Input type="date" className="dark:[color-scheme:dark]"
             value={state.date} onChange={e => state.setDate(e.target.value)} />
      <span className="block text-[10px] text-slate-400 dark:text-slate-400">
        {state.date
          ? T.inquiry.due.resolved(
              state.date.replaceAll('-', '/'),
              WEEKDAY_LABELS[parseYmd(state.date).getDay()],
            )
          : T.inquiry.due.noDeadline}
      </span>
    </div>
  )
}

/** 改已建立那筆的期望回覆日，用的是跟新增時同一組選項 */
function DueDateEditor({ inquiry, onSubmit, onCancel, busy }: {
  inquiry: Inquiry
  onSubmit: (dueDate: string | null) => void
  onCancel: () => void
  busy: boolean
}) {
  // 改已經發出去那筆的期限，意思幾乎都是「再寬限幾天」，所以從今天起算；
  // 從當初的提問日起算會挑出早就過去的日期，等於一存下去就逾期。
  const base = todayYmd()
  const due = useDueDate(base, () => ({
    preset: inquiry.dueDate ? ('CUSTOM' as DuePresetKey) : ('NONE' as DuePresetKey),
    date: toYmd(inquiry.dueDate) ?? '',
  }))

  return (
    <div className="w-48 space-y-1">
      <DueDateField state={due} />
      <div className="flex gap-1">
        <Button variant="primary" className="px-2 py-1 text-xs" disabled={busy}
                onClick={() => onSubmit(due.date || null)}>{T.common.save}</Button>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onCancel}>{T.common.cancel}</Button>
      </div>
    </div>
  )
}

/** 登錄回覆：預設帶入提問單位與今天，但都可以改 */
function ReplyRow({
  inquiry, workspaceId, onCancel, onSubmit, busy,
}: {
  inquiry: Inquiry
  workspaceId: string
  onCancel: () => void
  onSubmit: (v: Record<string, unknown>) => void
  busy: boolean
}) {
  const [unit, setUnit] = useState(inquiry.askedToUnit)
  const [person, setPerson] = useState(inquiry.askedToPerson ?? '')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const changed = unit !== inquiry.askedToUnit

  return (
    <tr className="border-t-2 border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/40 dark:bg-emerald-500/10">
      <td colSpan={5} className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
        {T.inquiry.table.reply.heading(inquiry.askedToUnit)}
        {changed && (
          <span className="ml-2 font-medium text-amber-700 dark:text-amber-300">
            {T.inquiry.table.reply.unitChanged}
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        <span aria-hidden>✓ </span>{T.inquiry.table.reply.mark}
      </td>
      <td className="px-2 py-2">
        <UnitInput workspaceId={workspaceId} value={unit} onChange={setUnit} />
      </td>
      <td className="px-2 py-2"><Input value={person} onChange={e => setPerson(e.target.value)} /></td>
      <td className="px-2 py-2">
        <Input type="date" className="dark:[color-scheme:dark]"
               value={date} onChange={e => setDate(e.target.value)} />
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right">
        <Button variant="primary" className="text-xs" disabled={busy}
                onClick={() => onSubmit({
                  repliedByUnit: unit.trim() || undefined,
                  repliedByPerson: person.trim() || undefined,
                  repliedAt: date,
                  replyNote: note.trim() || undefined,
                })}>{T.inquiry.table.reply.submit}</Button>
        <Button variant="ghost" className="ml-1 text-xs" onClick={onCancel}>{T.common.cancel}</Button>
      </td>
      <td colSpan={10} className="px-3 pb-2">
        <Input value={note} onChange={e => setNote(e.target.value)} placeholder={T.inquiry.table.placeholder.replyNote} />
      </td>
    </tr>
  )
}

/**
 * 單位輸入框：純自由文字，但把這個工作區用過的名稱列出來當提示。
 * 不綁死使用者，又能讓「資訊部 / 資訊處 / IT」不那麼容易長成三個值。
 */
export function UnitInput({
  workspaceId, value, onChange, placeholder, autoFocus,
}: {
  workspaceId: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['units', workspaceId, value],
    queryFn: () => Api.unitSuggestions(workspaceId, value),
    enabled: open,
    staleTime: 30_000,
  })

  // 下拉用 fixed 定位。表格外層有 overflow-x-auto，
  // absolute 的清單會被裁掉 —— 這種「明明有資料卻看不到」最難查。
  const measure = () => {
    const r = boxRef.current?.getBoundingClientRect()
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 160) })
  }

  useEffect(() => {
    if (!open) return
    measure()
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  const units = (data?.units ?? []).filter(u => u.unit !== value)

  return (
    <div ref={boxRef} className="relative">
      <Input
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); measure() }}
        onChange={e => { onChange(e.target.value); setOpen(true); measure() }}
      />
      {open && rect && units.length > 0 && (
        // 疊在卡片上的浮層用比卡片淺一階的底色，不然跟表格黏成一片
        <ul
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
          className="z-50 max-h-56 overflow-auto rounded-md bg-white py-1 shadow-lg ring-1 ring-slate-200
                     dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
        >
          {units.map(u => (
            <li key={u.unit}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm
                           hover:bg-slate-50 dark:hover:bg-slate-700"
                onMouseDown={e => { e.preventDefault(); onChange(u.unit); setOpen(false) }}
              >
                <span className="truncate">{u.unit}</span>
                <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-400">
                  {T.inquiry.unit.usage(u.usageCount)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const fmt = (d: string | null) => (d ? String(d).slice(0, 10).replaceAll('-', '/').slice(5) : T.common.none)
