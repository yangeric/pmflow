import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type Project } from '../lib/api'
import { Button, Input, cx } from '../components/ui'

/**
 * 登入後的第一個畫面：選一個專案再進去。
 *
 * 專案切換刻意做在這裡、而不是常駐在左側欄——側欄留給專案內的「大項目」。
 * 進去之後想換專案，走側欄頂端的「切換專案」再回到這一頁。
 */
export default function ProjectPicker({
  projects, workspaceId, userName, onPick, onInquiryBoard, onLogout, onAccount, bell,
}: {
  projects: Project[]
  workspaceId: string
  userName: string
  onPick: (id: string) => void
  onInquiryBoard: () => void
  onLogout: () => void
  onAccount: () => void
  /** 通知鈴鐺。被核准加入哪個專案，就是在這一頁才看得到差別 */
  bell?: ReactNode
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

  // ── 還沒加入的專案：要搜尋才找得到 ──────────────────────────
  /**
   * 同工作區、自己還不是成員的專案。只看得到門面（代碼、名稱、誰開的、幾個人），
   * 看不到裡面有什麼任務 —— 還沒獲准的人不該看到內容。
   *
   * **不預設列出來**，要打專案名稱或代碼搜尋。想加入的人本來就知道自己要找哪一個，
   * 而把整個工作區的專案攤開來，等於讓每個人都讀得到所有專案叫什麼名字。
   * 只有自己還在審核中的申請會一直顯示，不然送出去就撤不回來了。
   */
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  // 打字打到一半不要每個字都送一次查詢
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const { data: joinable, isFetching: searching } = useQuery({
    queryKey: ['joinableProjects', workspaceId, query],
    queryFn: () => Api.joinableProjects(workspaceId, query),
    enabled: !!workspaceId,
  })
  const others = joinable?.projects ?? []
  /** 正在填申請理由的專案 id */
  const [applyingTo, setApplyingTo] = useState<string | null>(null)
  const [applyMsg, setApplyMsg] = useState('')
  /** 申請的錯誤跟建立專案的錯誤分開，不然會顯示在錯的卡片上 */
  const [joinErr, setJoinErr] = useState<string | null>(null)

  const refreshJoin = () => {
    qc.invalidateQueries({ queryKey: ['joinableProjects'] })
    qc.invalidateQueries({ queryKey: ['projects'] })
  }
  const apply = useMutation({
    mutationFn: (projectId: string) => Api.applyToJoin(projectId, applyMsg.trim() || undefined),
    onSuccess: () => { setApplyingTo(null); setApplyMsg(''); setJoinErr(null); refreshJoin() },
    onError: (e: unknown) => setJoinErr(
      e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : '申請失敗'
    ),
  })
  const cancelApply = useMutation({
    mutationFn: (reqId: string) => Api.cancelJoinRequest(reqId),
    onSuccess: () => { setJoinErr(null); refreshJoin() },
  })

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="mx-auto max-w-4xl px-6 py-12">

        <div className="mb-8 flex items-baseline gap-3">
          <span className="text-xl font-semibold text-slate-800">PMFlow</span>
          <span className="text-sm text-slate-400">選一個專案開始</span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {bell}
            <span className="text-slate-500">{userName}</span>
            <button onClick={onAccount} className="text-slate-400 hover:text-slate-600">帳號設定</button>
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
                  {/* 只有建立者拿得到這個數字（後端擋著），所以出現就是「有人在等你核准」 */}
                  {(p.pendingJoinRequestCount ?? 0) > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                      🙋 {p.pendingJoinRequestCount} 人申請加入
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

        {/* ── 加入其他專案：搜尋得到才看得到 ── */}
        <div className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium tracking-wide text-slate-400">加入其他專案</span>
            <span className="text-xs text-slate-400">
              輸入專案名稱或代碼搜尋。要進去得由專案的建立者同意。
            </span>
          </div>

          <Input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="專案名稱或代碼，例如 MRG" maxLength={80} />

          {joinErr && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {joinErr}
            </div>
          )}

          {/* 沒打字時這裡通常是空的，只有自己還在審核中的申請會留著 */}
          {query !== '' && others.length === 0 && !searching && (
            <div className="mt-3 rounded-xl bg-white p-6 text-center text-sm text-slate-400 ring-1 ring-slate-200">
              找不到叫「{query}」的專案。<br />
              <span className="text-xs">
                名稱要對得上，或直接輸入專案代碼；已經加入的專案不會出現在這裡。
              </span>
            </div>
          )}

          {others.length > 0 && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {others.map(p => (
                <div key={p.id}
                     className="flex items-start gap-3 rounded-xl bg-white/60 p-4 ring-1 ring-slate-200">
                  <span className="mt-1 h-3 w-3 shrink-0 rounded-full opacity-60"
                        style={{ background: p.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
                        {p.key}
                      </span>
                      <span className="min-w-0 truncate font-medium text-slate-600">{p.name}</span>
                    </div>
                    <div className="mt-1.5 text-xs text-slate-400">
                      {p.createdByName ? `${p.createdByName} 建立` : '建立者不明'}．{p.memberCount} 位成員
                    </div>

                    {p.myRequestStatus === 'PENDING' ? (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
                          審核中
                        </span>
                        <button
                          onClick={() => p.myRequestId && cancelApply.mutate(p.myRequestId)}
                          className="text-slate-400 hover:text-slate-600">撤回申請</button>
                      </div>
                    ) : applyingTo === p.id ? (
                      <div className="mt-2 space-y-2">
                        <Input value={applyMsg} onChange={e => setApplyMsg(e.target.value)}
                               placeholder="想說明一下原因嗎？（可留白）" maxLength={500} autoFocus
                               onKeyDown={e => { if (e.key === 'Enter') apply.mutate(p.id) }} />
                        <div className="flex gap-2">
                          <Button variant="primary" disabled={apply.isPending}
                                  onClick={() => apply.mutate(p.id)}>送出申請</Button>
                          <Button onClick={() => { setApplyingTo(null); setApplyMsg('') }}>取消</Button>
                        </div>
                      </div>
                    ) : (
                      <Button className="mt-2"
                              onClick={() => { setApplyingTo(p.id); setApplyMsg(''); setJoinErr(null) }}>
                        申請加入
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
