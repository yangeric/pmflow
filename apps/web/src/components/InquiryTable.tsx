import { useState, useRef, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type Inquiry } from '../lib/api'
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
 */
export function InquiryTable({
  taskId, workspaceId, inquiries, canEdit,
}: {
  taskId: string; workspaceId: string; inquiries: Inquiry[]; canEdit: boolean
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [replyingId, setReplyingId] = useState<string | null>(null)
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

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">發文追蹤</h3>
        {canEdit && !adding && (
          <Button onClick={() => setAdding(true)} className="text-xs">＋ 新增單位</Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
        <table className="w-full min-w-[900px] border-collapse bg-white text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs font-medium text-slate-500">
              <th className="px-3 py-2">提給單位</th>
              <th className="px-3 py-2">承辦人</th>
              <th className="px-3 py-2">聯絡方式</th>
              <th className="px-3 py-2">提問日</th>
              <th className="px-3 py-2">期望回覆</th>
              <th className="px-3 py-2">狀態</th>
              <th className="px-3 py-2">回覆單位</th>
              <th className="px-3 py-2">回覆人</th>
              <th className="px-3 py-2">回覆日</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {inquiries.length === 0 && !adding && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">
                還沒有發文紀錄。按「＋ 新增單位」記錄這件事提給了誰。
              </td></tr>
            )}

            {inquiries.map(q => {
              const transferred = q.isReplied && q.repliedByUnit && q.repliedByUnit !== q.askedToUnit
              return (
                <tr key={q.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-800">{q.askedToUnit}</td>
                  <td className="px-3 py-2 text-slate-600">{q.askedToPerson ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{q.askedToContact ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{fmt(q.askedAt)}</td>
                  <td className="px-3 py-2 text-slate-500">{fmt(q.dueDate)}</td>
                  <td className="whitespace-nowrap px-3 py-2"><StatusCell q={q} /></td>
                  <td className={cx('px-3 py-2', transferred ? 'font-medium text-amber-700' : 'text-slate-600')}>
                    {q.repliedByUnit ?? '—'}
                    {transferred && <span className="ml-1 text-[10px] text-amber-600">轉單位</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{q.repliedByPerson ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{fmt(q.repliedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {canEdit && (q.isReplied
                      ? <Button variant="ghost" className="text-xs" onClick={() => reopen.mutate(q.id)}>退回待回覆</Button>
                      : <Button variant="primary" className="text-xs" onClick={() => setReplyingId(q.id)}>登錄回覆</Button>)}
                    {canEdit && (
                      <Button variant="ghost" className="ml-1 text-xs text-slate-400"
                              onClick={() => remove.mutate(q.id)} title="刪除">✕</Button>
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
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
        ✓ 已回{q.daysToReply != null && <span className="text-emerald-600/70">（{q.daysToReply} 天）</span>}
      </span>
    )
  }
  if (q.status === 'OVERDUE') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
        ⚠️ 逾期 {q.daysOverdue} 天
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20">
      ⏳ 已 {q.daysElapsed} 天
    </span>
  )
}

/** 新增一筆詢問單 */
function AskRow({
  workspaceId, onCancel, onSubmit, busy,
}: {
  workspaceId: string
  onCancel: () => void
  onSubmit: (v: Record<string, unknown>) => void
  busy: boolean
}) {
  const [unit, setUnit] = useState('')
  const [person, setPerson] = useState('')
  const [contact, setContact] = useState('')
  const [due, setDue] = useState('')
  const [question, setQuestion] = useState('')

  return (
    <tr className="border-t-2 border-blue-200 bg-blue-50/40">
      <td className="px-2 py-2">
        <UnitInput workspaceId={workspaceId} value={unit} onChange={setUnit}
                   placeholder="例如 採購部" autoFocus />
      </td>
      <td className="px-2 py-2"><Input value={person} onChange={e => setPerson(e.target.value)} placeholder="王小明" /></td>
      <td className="px-2 py-2"><Input value={contact} onChange={e => setContact(e.target.value)} placeholder="分機 2145" /></td>
      <td className="px-2 py-2 text-xs text-slate-400">今天</td>
      <td className="px-2 py-2">
        <Input type="date" value={due} onChange={e => setDue(e.target.value)} />
        <span className="mt-0.5 block text-[10px] text-slate-400">留空 = +7 工作天</span>
      </td>
      <td colSpan={4} className="px-2 py-2">
        <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder="要問什麼？（選填）" />
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right">
        <Button variant="primary" className="text-xs" disabled={!unit.trim() || busy}
                onClick={() => onSubmit({
                  askedToUnit: unit.trim(),
                  askedToPerson: person.trim() || undefined,
                  askedToContact: contact.trim() || undefined,
                  dueDate: due || undefined,
                  question: question.trim() || undefined,
                })}>儲存</Button>
        <Button variant="ghost" className="ml-1 text-xs" onClick={onCancel}>取消</Button>
      </td>
    </tr>
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
    <tr className="border-t-2 border-emerald-200 bg-emerald-50/40">
      <td colSpan={5} className="px-3 py-2 text-xs text-slate-500">
        登錄「{inquiry.askedToUnit}」這筆的回覆
        {changed && <span className="ml-2 font-medium text-amber-700">← 回覆單位已改成別的單位</span>}
      </td>
      <td className="px-2 py-2 text-xs text-emerald-700">✓ 已回覆</td>
      <td className="px-2 py-2">
        <UnitInput workspaceId={workspaceId} value={unit} onChange={setUnit} />
      </td>
      <td className="px-2 py-2"><Input value={person} onChange={e => setPerson(e.target.value)} /></td>
      <td className="px-2 py-2"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></td>
      <td className="whitespace-nowrap px-2 py-2 text-right">
        <Button variant="primary" className="text-xs" disabled={busy}
                onClick={() => onSubmit({
                  repliedByUnit: unit.trim() || undefined,
                  repliedByPerson: person.trim() || undefined,
                  repliedAt: date,
                  replyNote: note.trim() || undefined,
                })}>確認</Button>
        <Button variant="ghost" className="ml-1 text-xs" onClick={onCancel}>取消</Button>
      </td>
      <td colSpan={10} className="px-3 pb-2">
        <Input value={note} onChange={e => setNote(e.target.value)} placeholder="回覆重點摘要（選填）" />
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
        <ul
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
          className="z-50 max-h-56 overflow-auto rounded-md bg-white py-1 shadow-lg ring-1 ring-slate-200"
        >
          {units.map(u => (
            <li key={u.unit}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                onMouseDown={e => { e.preventDefault(); onChange(u.unit); setOpen(false) }}
              >
                <span className="truncate">{u.unit}</span>
                <span className="shrink-0 text-[10px] text-slate-400">用過 {u.usageCount} 次</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const fmt = (d: string | null) => (d ? String(d).slice(0, 10).replaceAll('-', '/').slice(5) : '—')
