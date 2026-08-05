import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, ApiError, type AdminUser, type WorkspaceRole } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, Field, Input, Select, Spinner, cx } from './ui'
import { T } from '../strings'
import { Avatar } from './Avatar'

/**
 * 系統管理 —— 工作區裡的帳號。
 *
 * 管的是「誰能登入這個站」：開帳號、停用帳號、刪帳號、調整工作區角色、代設密碼。
 * **不管專案內容** —— 管理者不會因此看得到任何一個專案，那仍然要專案建立者放行。
 * 兩套權限刻意分開，見 api/src/lib/auth.ts 的說明。
 *
 * **擁有者在這一頁看到的是完全不同的東西**：他管不到帳號，只能決定誰是管理者。
 * 開站的人不必然是該看每個人帳號的人；但不留這一項給他，最後一個管理者離職
 * 之後就沒有人能再指派下一個了。
 *
 * 站上沒有寄信的能力，所以新帳號的密碼是管理者當面給的，重設密碼也一樣。
 * 這件事在畫面上要寫清楚，不然管理者會等一封永遠不會寄出的信。
 * 連管理者自己都進不來的時候，最後一招是在主機上放檔案（api/src/lib/breakglass.ts）。
 */

const ROLE_LABEL = T.account.workspaceRole
const ROLE_HINT = T.account.workspaceRoleHint
const STATUS_LABEL = T.account.userStatus
const A = T.account.admin
const O = T.account.owner

const STATUS_CLS: Record<AdminUser['status'], string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  PENDING: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  SUSPENDED: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
}

const errText = (e: unknown) =>
  e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : T.common.failed

export default function AdminPanel(
  { workspaceId, myRole }: { workspaceId: string; myRole: WorkspaceRole }
) {
  // 擁有者連帳號清單都拿不到（後端會擋），所以連問都不要問
  if (myRole === 'OWNER') return <OwnerPanel workspaceId={workspaceId} />
  return <UserAdminPanel workspaceId={workspaceId} />
}

function UserAdminPanel({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    email: '', displayName: '', password: '', role: 'MEMBER' as WorkspaceRole,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['adminUsers', workspaceId], queryFn: () => Api.adminUsers(workspaceId),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['adminUsers', workspaceId] })
  const fail = (e: unknown) => { setMsg(null); setErr(errText(e)) }
  const done = (text: string) => { setErr(null); setMsg(text); refresh() }

  const patch = useMutation({
    mutationFn: (v: { userId: string; json: Parameters<typeof Api.adminPatchUser>[2] }) =>
      Api.adminPatchUser(workspaceId, v.userId, v.json),
    onSuccess: () => done(A.updated), onError: fail,
  })
  const create = useMutation({
    mutationFn: () => Api.adminCreateUser({ workspaceId, ...form }),
    onSuccess: () => {
      done(A.created(form.displayName))
      setForm({ email: '', displayName: '', password: '', role: 'MEMBER' })
      setCreating(false)
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (u: AdminUser) => Api.adminDeleteUser(workspaceId, u.id),
    onSuccess: (r, u) => done(
      r.projectsTransferred > 0
        ? A.deletedWithProjects(u.displayName, r.projectsTransferred)
        : A.deleted(u.displayName)
    ),
    onError: fail,
  })

  if (isLoading || !data) return <Spinner label={A.loading} />

  const users = data.users
  // 這些都是後端的規則，前端把按鈕收起來只是不要讓人按了才被拒絕：
  // 擁有者的帳號誰都動不了；管理者的身分只有擁有者能取消，所以管理者之間
  // 不互相改角色、也不互刪，但還是可以幫對方停用或重設密碼
  const canEdit = (u: AdminUser) => u.id !== user?.id && u.role !== 'OWNER'
  const canChangeRole = (u: AdminUser) => canEdit(u) && u.role !== 'ADMIN'

  return (
    <div className="h-full overflow-auto bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{A.title}</h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500
                           dark:bg-slate-800 dark:text-slate-400">
            {A.myRole(ROLE_LABEL[data.myRole])}
          </span>
          <Button className="ml-auto" variant="primary"
                  onClick={() => { setCreating(c => !c); setMsg(null); setErr(null) }}>
            {creating ? T.common.cancel : A.createToggle}
          </Button>
        </div>

        {err && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50
                          px-3 py-2 text-sm text-red-700">
            <span className="flex-1">{err}</span>
            <button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">✕</button>
          </div>
        )}
        {msg && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50
                          px-3 py-2 text-sm text-emerald-700
                          dark:border-emerald-500/30 dark:bg-emerald-500/15
                          dark:text-emerald-300">{msg}</div>
        )}

        {/* ── 新增帳號 ── */}
        {creating && (
          <section className="mb-6 rounded-xl bg-white p-5 ring-1 ring-slate-200
                              dark:bg-slate-900 dark:ring-slate-700">
            <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
              {A.createTitle}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={A.email}>
                <Input value={form.email} type="email"
                       onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </Field>
              <Field label={A.displayName}>
                <Input value={form.displayName}
                       onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} />
              </Field>
              <Field label={A.initialPassword}>
                <Input value={form.password} type="text" autoComplete="off"
                       onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
              </Field>
              <Field label={A.role}>
                <Select value={form.role} className="w-full"
                        onChange={e => setForm(f => ({ ...f, role: e.target.value as WorkspaceRole }))}>
                  {data.roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </Select>
              </Field>
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {ROLE_HINT[form.role]}
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              {A.noMailHint}
            </p>
            <div className="mt-4">
              <Button variant="primary"
                      disabled={
                        !form.email.trim() || !form.displayName.trim()
                        || form.password.length < 8 || create.isPending
                      }
                      onClick={() => create.mutate()}>{T.common.create}</Button>
            </div>
          </section>
        )}

        {/* ── 帳號清單 ── */}
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200
                        dark:bg-slate-900 dark:ring-slate-700">
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2
                          text-xs font-medium text-slate-500
                          dark:border-slate-800 dark:text-slate-400">
            <span className="flex-1">{A.colAccount}</span>
            <span className="w-24 text-center">{A.colStatus}</span>
            <span className="w-28 text-center">{A.colProjects}</span>
            <span className="w-28 text-center">{A.colRole}</span>
            <span className="w-40" />
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {users.map(u => (
              <UserRow key={u.id} user={u} isMe={u.id === user?.id} editable={canEdit(u)}
                       roleEditable={canChangeRole(u)} roles={data.roles}
                       busy={patch.isPending || remove.isPending}
                       onPatch={json => patch.mutate({ userId: u.id, json })}
                       onDelete={() => remove.mutate(u)} />
            ))}
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-400 dark:text-slate-400">{A.footHint}</p>
      </div>
    </div>
  )
}

function UserRow({
  user: u, isMe, editable, roleEditable, roles, busy, onPatch, onDelete,
}: {
  user: AdminUser
  isMe: boolean
  editable: boolean
  roleEditable: boolean
  roles: WorkspaceRole[]
  busy: boolean
  onPatch: (json: Parameters<typeof Api.adminPatchUser>[2]) => void
  onDelete: () => void
}) {
  const suspended = u.status === 'SUSPENDED'
  return (
    <div className={cx('flex items-center gap-3 px-4 py-3',
                       suspended && 'bg-slate-50 dark:bg-slate-950/60')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cx('truncate text-sm font-medium',
                              suspended
                                ? 'text-slate-400 dark:text-slate-400'
                                : 'text-slate-800 dark:text-slate-100')}>
            {u.displayName}
          </span>
          {isMe && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700
                             dark:bg-blue-500/15 dark:text-blue-300">{A.me}</span>
          )}
        </div>
        <div className="truncate text-xs text-slate-400 dark:text-slate-400">{u.email}</div>
      </div>

      <span className={cx('w-24 rounded px-2 py-0.5 text-center text-[11px]', STATUS_CLS[u.status])}>
        {STATUS_LABEL[u.status]}
      </span>

      {/* 停用之前先看得到他手上有什麼，不然沒人知道誰要接手 */}
      <span className="w-28 text-center text-xs text-slate-500 dark:text-slate-400">
        {A.projectCount(Number(u.projectCount))}
        {Number(u.createdCount) > 0 && (
          <span className="text-slate-400 dark:text-slate-400">
            {A.createdCount(Number(u.createdCount))}
          </span>
        )}
      </span>

      <div className="w-28 text-center">
        {roleEditable ? (
          <Select value={u.role} disabled={busy} className="w-full px-1.5 py-1 text-xs"
                  onChange={e => onPatch({ role: e.target.value as WorkspaceRole })}>
            {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        ) : (
          <span className="text-xs text-slate-500 dark:text-slate-400">{ROLE_LABEL[u.role]}</span>
        )}
      </div>

      <div className="flex w-40 items-center justify-end gap-1">
        {editable && (
          <>
            <button
              onClick={() => {
                const pw = window.prompt(A.promptNewPassword(u.displayName))
                if (pw && pw.length >= 8) onPatch({ newPassword: pw })
                else if (pw) window.alert(A.passwordTooShort)
              }}
              className="rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700
                         dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
              {A.resetPassword}
            </button>
            <button
              onClick={() => {
                const next = suspended ? 'ACTIVE' : 'SUSPENDED'
                const ask = suspended
                  ? A.confirmResume(u.displayName)
                  : A.confirmSuspend(u.displayName)
                if (window.confirm(ask)) onPatch({ status: next })
              }}
              className={cx('rounded px-1.5 py-1 text-xs',
                            suspended
                              ? 'text-emerald-600 hover:bg-emerald-50 '
                                + 'dark:text-emerald-400 dark:hover:bg-emerald-500/10'
                              : 'text-slate-400 hover:bg-red-50 hover:text-red-600 '
                                + 'dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400')}>
              {suspended ? A.resume : A.suspend}
            </button>
            {/* 刪除只給成員與訪客 —— 管理者要先請擁有者取消他的身分，這是後端的規則 */}
            {roleEditable && (
              <button
                onClick={() => {
                  const created = Number(u.createdCount)
                  const ask = [
                    A.confirmDelete(u.displayName),
                    created > 0 ? A.confirmDeleteProjects(created) : '',
                    A.confirmDeleteTasks,
                    A.confirmDeleteSuspendInstead,
                  ].filter(Boolean).join('\n')
                  if (window.confirm(ask)) onDelete()
                }}
                disabled={busy}
                className="rounded px-1.5 py-1 text-xs text-slate-400
                           hover:bg-red-50 hover:text-red-600 disabled:opacity-50
                           dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400">
                {T.common.delete}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 擁有者看到的系統管理：只有「誰是管理者」這一件事。
 *
 * 這裡刻意只列名字與 email —— 帳號的狀態、參與幾個專案那些細節是管理者的事。
 * 後端也不會回那些欄位，不是前端自己藏起來的。
 */
function OwnerPanel({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['adminAdministrators', workspaceId],
    queryFn: () => Api.adminAdministrators(workspaceId),
  })

  const setAdmin = useMutation({
    mutationFn: (v: { userId: string; isAdmin: boolean }) =>
      Api.adminSetAdministrator(workspaceId, v.userId, v.isAdmin),
    onSuccess: () => {
      setErr(null)
      qc.invalidateQueries({ queryKey: ['adminAdministrators', workspaceId] })
    },
    onError: e => setErr(errText(e)),
  })

  if (isLoading || !data) return <Spinner label={O.loading} />

  const admins = data.users.filter(u => u.isAdmin)

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{A.title}</h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500
                           dark:bg-slate-800 dark:text-slate-400">
            {O.myRole}
          </span>
        </div>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">{O.intro}</p>

        {err && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700
                          dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
            {err}
          </div>
        )}

        {admins.length === 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800
                          dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
            {O.noAdmins}
          </div>
        )}

        <div className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200
                        dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-700">
          {data.users.map(u => (
            <div key={u.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar userId={u.id} name={u.displayName} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {u.displayName}
                  </span>
                  {u.isOwner && (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700
                                     dark:bg-blue-500/15 dark:text-blue-300">
                      {O.meOwner}
                    </span>
                  )}
                  {u.isAdmin && (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700
                                     dark:bg-emerald-500/15 dark:text-emerald-300">
                      {O.isAdmin}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-slate-400 dark:text-slate-400">{u.email}</div>
              </div>

              {!u.isOwner && (
                <Button
                  variant={u.isAdmin ? 'ghost' : 'primary'}
                  disabled={setAdmin.isPending}
                  onClick={() => {
                    const ask = u.isAdmin
                      ? O.confirmRevoke(u.displayName)
                      : O.confirmGrant(u.displayName)
                    if (window.confirm(ask)) {
                      setAdmin.mutate({ userId: u.id, isAdmin: !u.isAdmin })
                    }
                  }}>
                  {u.isAdmin ? O.revoke : O.grant}
                </Button>
              )}
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-slate-400 dark:text-slate-400">{O.footHint}</p>
      </div>
    </div>
  )
}
