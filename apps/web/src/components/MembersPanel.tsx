import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type ProjectRole } from '../lib/api'
import { Button, Empty, Spinner, cx } from '../components/ui'
import { Avatar } from './Avatar'

/**
 * 專案成員管理。
 *
 * 規則只有一條：**專案是誰開的，誰才能決定誰進得來。** 其他人看得到成員名單
 * （知道要找誰問事情很重要），但看不到有誰在敲門、也按不了核准 —— 待審清單
 * 與所有操作按鈕都掛在 canManage 底下，那是後端回的，不是前端自己猜的。
 *
 * 沒有做通知信，所以「有人申請」只靠這個頁籤上的紅點提醒。
 */

const ROLE_LABEL: Record<ProjectRole, string> = {
  MANAGER: '管理者', EDITOR: '編輯者', COMMENTER: '可留言', VIEWER: '唯讀',
}
const ROLES = Object.keys(ROLE_LABEL) as ProjectRole[]

export default function MembersPanel({
  projectId, workspaceId,
}: {
  projectId: string
  workspaceId: string
}) {
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  /** 準備加進來的帳號；空字串＝還沒挑 */
  const [pickUser, setPickUser] = useState('')
  const [pickRole, setPickRole] = useState<ProjectRole>('EDITOR')
  /** 每筆申請核准時要給的角色，沒挑過就是 EDITOR */
  const [reqRole, setReqRole] = useState<Record<string, ProjectRole>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['members', projectId], queryFn: () => Api.members(projectId),
  })
  const canManage = !!data?.canManage

  const { data: reqData } = useQuery({
    queryKey: ['joinRequests', projectId], queryFn: () => Api.joinRequests(projectId),
    enabled: canManage,
  })
  const { data: usersData } = useQuery({
    queryKey: ['workspaceUsers', workspaceId], queryFn: () => Api.workspaceUsers(workspaceId),
    enabled: canManage,
  })

  const members = data?.members ?? []
  const requests = reqData?.requests ?? []
  const memberIds = new Set(members.map(m => m.id))
  const addable = (usersData?.users ?? []).filter(u => !memberIds.has(u.id))

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['members', projectId] })
    qc.invalidateQueries({ queryKey: ['joinRequests', projectId] })
    // 專案清單上的待審紅點也要跟著減
    qc.invalidateQueries({ queryKey: ['projects'] })
  }
  const fail = (e: unknown) => setErr(
    e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : '操作失敗'
  )
  const ok = () => { setErr(null); refresh() }

  const approve = useMutation({
    mutationFn: (v: { reqId: string; role: ProjectRole }) =>
      Api.approveJoin(projectId, v.reqId, { role: v.role }),
    onSuccess: ok, onError: fail,
  })
  const reject = useMutation({
    mutationFn: (reqId: string) => Api.rejectJoin(projectId, reqId),
    onSuccess: ok, onError: fail,
  })
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: ProjectRole }) =>
      Api.setMemberRole(projectId, v.userId, v.role),
    onSuccess: ok, onError: fail,
  })
  const remove = useMutation({
    mutationFn: (userId: string) => Api.removeMember(projectId, userId),
    onSuccess: ok, onError: fail,
  })
  const add = useMutation({
    mutationFn: () => Api.addMember(projectId, { userId: pickUser, role: pickRole }),
    onSuccess: () => { setPickUser(''); ok() }, onError: fail,
  })

  if (isLoading) return <Spinner label="載入成員…" />

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="mx-auto max-w-3xl px-6 py-8">

        {err && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50
                          px-3 py-2 text-sm text-red-700">
            <span className="flex-1">{err}</span>
            <button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">✕</button>
          </div>
        )}

        {/* ── 待審申請。只有建立者看得到 ── */}
        {canManage && (
          <section className="mb-8">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-700">加入申請</h2>
              {requests.length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  {requests.length} 件待處理
                </span>
              )}
            </div>
            {requests.length === 0 ? (
              <div className="rounded-xl bg-white px-4 py-6 text-center text-sm text-slate-400
                              ring-1 ring-slate-200">
                目前沒有人申請加入
              </div>
            ) : (
              <div className="space-y-2">
                {requests.map(r => (
                  <div key={r.id}
                       className="rounded-xl bg-white p-4 ring-1 ring-amber-200">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-800">{r.displayName}</div>
                        <div className="text-xs text-slate-400">{r.email}</div>
                        {r.message && (
                          <div className="mt-1.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            「{r.message}」
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {/* 核准的同時就決定角色，不必事後再改一次 */}
                        <select value={reqRole[r.id] ?? 'EDITOR'}
                                onChange={e => setReqRole(m => ({
                                  ...m, [r.id]: e.target.value as ProjectRole,
                                }))}
                                className="rounded-md border border-slate-300 px-2 py-1 text-sm">
                          {ROLES.map(v => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
                        </select>
                        <Button
                          variant="primary"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate({
                            reqId: r.id, role: reqRole[r.id] ?? 'EDITOR',
                          })}>核准</Button>
                        <Button disabled={reject.isPending}
                                onClick={() => reject.mutate(r.id)}>婉拒</Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── 成員清單 ── */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-700">成員</h2>
            <span className="text-xs text-slate-400">{members.length} 人</span>
            {!canManage && (
              <span className="ml-auto text-xs text-slate-400">
                只有專案的建立者可以增減成員
              </span>
            )}
          </div>

          {members.length === 0 ? (
            <Empty>這個專案還沒有成員。</Empty>
          ) : (
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
              {members.map(m => (
                <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar userId={m.id} name={m.displayName} hasAvatar={m.hasAvatar} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-800">
                        {m.displayName}
                      </span>
                      {m.isCreator && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                          建立者
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-400">{m.email}</div>
                  </div>

                  {/* 建立者自己的角色不能改、也不能被移除 —— 不然專案就沒人管成員了 */}
                  {canManage && !m.isCreator ? (
                    <>
                      <select value={m.role} disabled={setRole.isPending}
                              onChange={e => setRole.mutate({
                                userId: m.id, role: e.target.value as ProjectRole,
                              })}
                              className="rounded-md border border-slate-300 px-2 py-1 text-sm">
                        {ROLES.map(v => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
                      </select>
                      <button
                        onClick={() => {
                          if (window.confirm(`要把 ${m.displayName} 移出這個專案嗎？`)) {
                            remove.mutate(m.id)
                          }
                        }}
                        className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600">
                        移除
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">{ROLE_LABEL[m.role]}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 直接加人。不必等對方申請 ── */}
        {canManage && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">直接加入成員</h2>
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <select value={pickUser} onChange={e => setPickUser(e.target.value)}
                      className="min-w-56 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                <option value="">選一個帳號…</option>
                {addable.map(u => (
                  <option key={u.id} value={u.id}>{u.displayName}（{u.email}）</option>
                ))}
              </select>
              <select value={pickRole} onChange={e => setPickRole(e.target.value as ProjectRole)}
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                {ROLES.map(v => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
              </select>
              <Button variant="primary" disabled={!pickUser || add.isPending}
                      onClick={() => add.mutate()}>加入</Button>
            </div>
            <p className={cx('mt-1.5 text-xs', addable.length ? 'text-slate-400' : 'text-slate-500')}>
              {addable.length
                ? '只列得出同一個工作區裡的帳號。對方不會收到信，直接就是成員了。'
                : '同工作區的帳號都已經在這個專案裡了。'}
            </p>
          </section>
        )}

      </div>
    </div>
  )
}
