import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type Project } from '../lib/api'
import { T } from '../strings'
import { Button, Input, cx } from '../components/ui'

/**
 * 登入後的第一個畫面：選一個專案再進去。
 *
 * 專案切換刻意做在這裡、而不是常駐在左側欄——側欄留給專案內的「大項目」。
 * 進去之後想換專案，走側欄頂端的「切換專案」再回到這一頁。
 */
export default function ProjectPicker({
  projects, workspaceId, onPick, bell, menu,
}: {
  projects: Project[]
  workspaceId: string
  onPick: (id: string) => void
  /** 通知鈴鐺。被核准加入哪個專案，就是在這一頁才看得到差別 */
  bell?: ReactNode
  /** 右上角的頭像選單：帳號設定、系統管理、外觀、登出 */
  menu?: ReactNode
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

  // ── 公開與否：只有建立者能改 ────────────────────────────
  /**
   * 專案還沒有設定頁，而這個開關只有「在專案清單上看得到自己開的專案」時才用得到，
   * 所以直接掛在卡片上。改完要重抓 projects，卡片上的狀態才會跟著翻。
   *
   * 失敗訊息記在哪一張卡片上 —— 一次只會有一張，但不記 id 會顯示在錯的專案下面。
   */
  const [visibilityErr, setVisibilityErr] = useState<{ id: string; message: string } | null>(null)
  const setPublic = useMutation({
    mutationFn: (v: { id: string; isPublic: boolean }) =>
      Api.patchProject(v.id, { isPublic: v.isPublic }),
    onSuccess: () => {
      setVisibilityErr(null)
      qc.invalidateQueries({ queryKey: ['projects'] })
      // 公開與否會換掉別人搜尋得到的結果，順手把那份也作廢
      qc.invalidateQueries({ queryKey: ['joinableProjects'] })
    },
    onError: (e: unknown, v) => setVisibilityErr({
      id: v.id,
      message: e instanceof ApiError
        ? [e.title, e.detail].filter(Boolean).join('：')
        : T.project.visibility.failed,
    }),
  })

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
      e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : T.project.join.failed
    ),
  })
  const cancelApply = useMutation({
    mutationFn: (reqId: string) => Api.cancelJoinRequest(reqId),
    onSuccess: () => { setJoinErr(null); refreshJoin() },
  })

  return (
    <div className="h-full overflow-auto bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-4xl px-6 py-12">

        <div className="mb-8 flex items-baseline gap-3">
          <span className="text-xl font-semibold text-slate-800 dark:text-slate-100">
            {T.nav.appName}
          </span>
          <span className="text-sm text-slate-400 dark:text-slate-400">{T.project.pickOne}</span>
          <div className="ml-auto flex items-center gap-2 text-sm">
            {bell}
            {menu}
          </div>
        </div>

        {/*
          發文追蹤刻意不放在這一頁：它是專案裡的東西，要進到專案才看得到，
          而且只看得到那個專案的。入口在專案裡那排頁籤上。
        */}

        <div className="mb-2 text-xs font-medium tracking-wide text-slate-400 dark:text-slate-400">
          {T.project.section}
        </div>

        {projects.length === 0 && !adding && (
          <div className="rounded-xl bg-white p-8 text-center ring-1 ring-slate-200
                          dark:bg-slate-900 dark:ring-slate-700">
            <div className="text-sm text-slate-500 dark:text-slate-400">{T.project.empty}</div>
            <Button variant="primary" className="mt-3" onClick={() => setAdding(true)}>
              ＋ {T.project.createFirst}
            </Button>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map(p => (
            /* 外面這層只是給公開切換一個定位的參考點，它本身不能點 —— 見下面的註解 */
            <div key={p.id} className="relative">
            <button
              onClick={() => onPick(p.id)}
              className={cx(
                'flex h-full w-full items-start gap-3 rounded-xl bg-white p-4 text-left',
                'ring-1 ring-slate-200 transition hover:ring-2 hover:ring-slate-400',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900',
                'dark:bg-slate-900 dark:ring-slate-700 dark:hover:ring-slate-500',
                'dark:focus-visible:ring-slate-300',
                // 底下要空出一列放公開切換，不然會壓到逾期、申請那些標記
                p.isCreator && 'pb-12'
              )}
            >
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: p.color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500
                                   dark:bg-slate-800 dark:text-slate-400">
                    {p.key}
                  </span>
                  <span className="min-w-0 truncate font-medium text-slate-800 dark:text-slate-100">
                    {p.name}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400
                                dark:text-slate-400">
                  <span>{T.project.taskCount(p.taskCount ?? 0)}</span>
                  {(p.overdueInquiryCount ?? 0) > 0 && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700
                                     dark:bg-red-500/15 dark:text-red-300">
                      ⚠️ {T.project.overdueUnreplied(p.overdueInquiryCount ?? 0)}
                    </span>
                  )}
                  {/* 只有建立者拿得到這個數字（後端擋著），所以出現就是「有人在等你核准」 */}
                  {(p.pendingJoinRequestCount ?? 0) > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800
                                     dark:bg-amber-500/15 dark:text-amber-300">
                      🙋 {T.project.pendingJoins(p.pendingJoinRequestCount ?? 0)}
                    </span>
                  )}
                </div>
              </div>
            </button>

            {/*
              公開與否只有建立者能改。
              刻意畫在卡片按鈕「外面」再用絕對定位疊回卡片內 ——
              button 包 button 是不合法的 HTML，瀏覽器會把它拆掉；
              事件也一併保險：點切換不該連帶把人帶進專案。
            */}
            {p.isCreator && (
              <div className="absolute inset-x-4 bottom-3 flex items-center gap-2">
                <Button
                  className="shrink-0 px-2 py-1 text-xs"
                  aria-pressed={!!p.isPublic}
                  title={T.project.visibility.tooltip(!!p.isPublic)}
                  aria-label={T.project.visibility.ariaLabel(!!p.isPublic, p.name)}
                  disabled={setPublic.isPending && setPublic.variables?.id === p.id}
                  onClick={e => {
                    e.stopPropagation()
                    setVisibilityErr(null)
                    setPublic.mutate({ id: p.id, isPublic: !p.isPublic })
                  }}
                >
                  <span aria-hidden>{p.isPublic ? '🌐' : '🔒'}</span>
                  {T.project.visibility.label(!!p.isPublic)}
                </Button>
                {visibilityErr?.id === p.id ? (
                  <span className="min-w-0 truncate text-[11px] text-red-600 dark:text-red-400">
                    {visibilityErr.message}
                  </span>
                ) : (
                  <span className="min-w-0 truncate text-[11px] text-slate-400 dark:text-slate-400">
                    {T.project.visibility.hint(!!p.isPublic)}
                  </span>
                )}
              </div>
            )}
            </div>
          ))}

          {adding ? (
            <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-300
                            dark:bg-slate-900 dark:ring-slate-600">
              <Input value={key} onChange={e => setKey(e.target.value.toUpperCase())}
                     placeholder={T.project.keyPlaceholder} maxLength={10} autoFocus />
              <Input value={name} onChange={e => setName(e.target.value)}
                     placeholder={T.project.namePlaceholder}
                     onKeyDown={e => { if (e.key === 'Enter' && key && name) create.mutate() }} />
              {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
              <div className="flex gap-2">
                <Button variant="primary" className="flex-1 justify-center"
                        disabled={!key || !name || create.isPending}
                        onClick={() => create.mutate()}>{T.common.create}</Button>
                <Button onClick={() => { setAdding(false); setErr(null) }}>{T.common.cancel}</Button>
              </div>
            </div>
          ) : projects.length > 0 && (
            <button
              onClick={() => setAdding(true)}
              className={cx(
                'flex items-center justify-center gap-2 rounded-xl border-2 border-dashed',
                'border-slate-300 p-4 text-sm text-slate-400 transition',
                'hover:border-slate-400 hover:text-slate-600',
                'dark:border-slate-700 dark:text-slate-400',
                'dark:hover:border-slate-500 dark:hover:text-slate-300'
              )}
            >
              ＋ {T.project.createAnother}
            </button>
          )}
        </div>

        {/* ── 加入其他專案：搜尋得到才看得到 ── */}
        <div className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium tracking-wide text-slate-400 dark:text-slate-400">
              {T.project.join.section}
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-400">
              {T.project.join.hint}
            </span>
          </div>

          <Input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder={T.project.join.searchPlaceholder} maxLength={80} />

          {joinErr && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700
                            dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
              {joinErr}
            </div>
          )}

          {/* 沒打字時這裡通常是空的，只有自己還在審核中的申請會留著 */}
          {query !== '' && others.length === 0 && !searching && (
            <div className="mt-3 rounded-xl bg-white p-6 text-center text-sm text-slate-400 ring-1 ring-slate-200
                            dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-700">
              {T.project.join.notFound(query)}<br />
              <span className="text-xs">{T.project.join.notFoundHint}</span>
            </div>
          )}

          {others.length > 0 && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {others.map(p => (
                <div key={p.id}
                     className="flex items-start gap-3 rounded-xl bg-white/60 p-4 ring-1 ring-slate-200
                                dark:bg-slate-900/60 dark:ring-slate-700">
                  <span className="mt-1 h-3 w-3 shrink-0 rounded-full opacity-60"
                        style={{ background: p.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500
                                       dark:bg-slate-800 dark:text-slate-400">
                        {p.key}
                      </span>
                      <span className="min-w-0 truncate font-medium text-slate-600 dark:text-slate-300">
                        {p.name}
                      </span>
                    </div>
                    <div className="mt-1.5 text-xs text-slate-400 dark:text-slate-400">
                      {T.project.join.creatorAndMembers(p.createdByName, p.memberCount)}
                    </div>

                    {p.myRequestStatus === 'PENDING' ? (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800
                                         dark:bg-amber-500/15 dark:text-amber-300">
                          {T.project.join.pending}
                        </span>
                        <button
                          onClick={() => p.myRequestId && cancelApply.mutate(p.myRequestId)}
                          className="text-slate-400 hover:text-slate-600
                                     dark:text-slate-400 dark:hover:text-slate-300">
                          {T.project.join.cancel}
                        </button>
                      </div>
                    ) : applyingTo === p.id ? (
                      <div className="mt-2 space-y-2">
                        <Input value={applyMsg} onChange={e => setApplyMsg(e.target.value)}
                               placeholder={T.project.join.messagePlaceholder} maxLength={500} autoFocus
                               onKeyDown={e => { if (e.key === 'Enter') apply.mutate(p.id) }} />
                        <div className="flex gap-2">
                          <Button variant="primary" disabled={apply.isPending}
                                  onClick={() => apply.mutate(p.id)}>{T.project.join.submit}</Button>
                          <Button onClick={() => { setApplyingTo(null); setApplyMsg('') }}>
                            {T.common.cancel}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button className="mt-2"
                              onClick={() => { setApplyingTo(p.id); setApplyMsg(''); setJoinErr(null) }}>
                        {T.project.join.apply}
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
