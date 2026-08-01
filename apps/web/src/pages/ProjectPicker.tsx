import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Api, type Project } from '../lib/api'
import { Button, Input, cx } from '../components/ui'

/**
 * 登入後的第一個畫面：選一個專案再進去。
 *
 * 專案切換刻意做在這裡、而不是常駐在左側欄——側欄留給專案內的「大項目」。
 * 進去之後想換專案，走側欄頂端的「切換專案」再回到這一頁。
 */
export default function ProjectPicker({
  projects, workspaceId, userName, onPick, onInquiryBoard, onLogout,
}: {
  projects: Project[]
  workspaceId: string
  userName: string
  onPick: (id: string) => void
  onInquiryBoard: () => void
  onLogout: () => void
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => Api.createProject({ workspaceId, key: key.toUpperCase(), name }),
    onSuccess: p => {
      setAdding(false); setKey(''); setName(''); setErr(null)
      qc.invalidateQueries({ queryKey: ['projects'] })
      onPick(p.id)
    },
    onError: (e: Error) => setErr(e.message),
  })

  const totalOverdue = projects.reduce((n, p) => n + (p.overdueInquiryCount ?? 0), 0)

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="mx-auto max-w-4xl px-6 py-12">

        <div className="mb-8 flex items-baseline gap-3">
          <span className="text-xl font-semibold text-slate-800">PMFlow</span>
          <span className="text-sm text-slate-400">選一個專案開始</span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-500">{userName}</span>
            <button onClick={onLogout} className="text-slate-400 hover:text-slate-600">登出</button>
          </div>
        </div>

        {/* 發文追蹤是跨專案的，所以放在專案清單之外 */}
        <button
          onClick={onInquiryBoard}
          className="mb-6 flex w-full items-center gap-3 rounded-xl bg-white px-4 py-3 text-left
                     ring-1 ring-slate-200 transition hover:ring-slate-400"
        >
          <span className="text-lg">📮</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">發文追蹤</div>
            <div className="text-xs text-slate-400">跨所有專案，看發出去的事情回了沒</div>
          </div>
          {totalOverdue > 0 && (
            <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
              {totalOverdue} 件逾期
            </span>
          )}
        </button>

        <div className="mb-2 text-xs font-medium tracking-wide text-slate-400">專案</div>

        {projects.length === 0 && !adding && (
          <div className="rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
            <div className="text-sm text-slate-500">還沒有任何專案</div>
            <Button variant="primary" className="mt-3" onClick={() => setAdding(true)}>
              ＋ 建立第一個專案
            </Button>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className="flex items-start gap-3 rounded-xl bg-white p-4 text-left ring-1 ring-slate-200
                         transition hover:ring-2 hover:ring-slate-400
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: p.color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
                    {p.key}
                  </span>
                  <span className="min-w-0 truncate font-medium text-slate-800">{p.name}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400">
                  <span>{p.taskCount ?? 0} 個任務</span>
                  {(p.overdueInquiryCount ?? 0) > 0 && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">
                      ⚠️ {p.overdueInquiryCount} 件逾期未回
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}

          {adding ? (
            <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-300">
              <Input value={key} onChange={e => setKey(e.target.value.toUpperCase())}
                     placeholder="專案代碼，如 MRG" maxLength={10} autoFocus />
              <Input value={name} onChange={e => setName(e.target.value)}
                     placeholder="專案名稱"
                     onKeyDown={e => { if (e.key === 'Enter' && key && name) create.mutate() }} />
              {err && <div className="text-xs text-red-600">{err}</div>}
              <div className="flex gap-2">
                <Button variant="primary" className="flex-1 justify-center"
                        disabled={!key || !name || create.isPending}
                        onClick={() => create.mutate()}>建立</Button>
                <Button onClick={() => { setAdding(false); setErr(null) }}>取消</Button>
              </div>
            </div>
          ) : projects.length > 0 && (
            <button
              onClick={() => setAdding(true)}
              className={cx(
                'flex items-center justify-center gap-2 rounded-xl border-2 border-dashed',
                'border-slate-300 p-4 text-sm text-slate-400 transition',
                'hover:border-slate-400 hover:text-slate-600'
              )}
            >
              ＋ 建立新專案
            </button>
          )}
        </div>

      </div>
    </div>
  )
}
