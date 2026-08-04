import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Api, ApiError, type WorkspaceRole } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, Field, Input, Spinner } from './ui'
import { Avatar, AvatarPicker } from './Avatar'

/**
 * 自己的帳號設定。
 *
 * 只做四件事：換頭像、改顯示名稱、改 email、改密碼。刻意不做通知偏好、
 * 兩階段驗證 —— 這個站沒有寄信的能力，做了也走不完流程。
 *
 * 改密碼會把**所有裝置**的登入作廢，包含現在這一台（後端會把 refresh token
 * 全部撤掉）。與其讓使用者在下次開頁時莫名被登出，不如當場登出、當場重登，
 * 至少他知道發生了什麼事。
 */

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: '擁有者', ADMIN: '管理者', MEMBER: '成員', GUEST: '訪客',
}

const errText = (e: unknown) =>
  e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : '操作失敗'

export default function AccountPanel() {
  const { refreshUser, logout } = useAuth()
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['myProfile'], queryFn: () => Api.myProfile(),
  })

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [profileMsg, setProfileMsg] = useState<string | null>(null)
  const [profileErr, setProfileErr] = useState<string | null>(null)

  const [avatarErr, setAvatarErr] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwErr, setPwErr] = useState<string | null>(null)

  // 資料回來之後才有東西可以填；使用者改到一半重新整理不會被蓋掉，因為只跑一次
  useEffect(() => {
    if (!data) return
    setDisplayName(data.user.displayName)
    setEmail(data.user.email)
  }, [data])

  const saveProfile = useMutation({
    mutationFn: () => Api.updateProfile({ displayName, email }),
    onSuccess: async () => {
      setProfileErr(null)
      setProfileMsg('已儲存')
      await refetch()
      await refreshUser()
    },
    onError: e => { setProfileMsg(null); setProfileErr(errText(e)) },
  })

  // 換完之後 refetch 是為了拿到新檔名 —— 檔名帶時間戳，也就是 <Avatar> 的 version，
  // 沒有它畫面會停在瀏覽器快取的舊圖上
  const saveAvatar = useMutation({
    mutationFn: (image: string) => Api.uploadAvatar(image),
    onSuccess: async () => { setAvatarErr(null); await refetch(); await refreshUser() },
    onError: e => setAvatarErr(errText(e)),
  })

  const dropAvatar = useMutation({
    mutationFn: () => Api.removeAvatar(),
    onSuccess: async () => { setAvatarErr(null); await refetch(); await refreshUser() },
    onError: e => setAvatarErr(errText(e)),
  })

  const changePassword = useMutation({
    mutationFn: () => Api.changePassword({ currentPassword, newPassword }),
    onSuccess: async () => {
      setPwErr(null)
      // 後端已經把所有 refresh token 撤掉了，這台也不例外 —— 直接送回登入頁
      await logout()
    },
    onError: e => setPwErr(errText(e)),
  })

  if (isLoading || !data) return <Spinner label="載入帳號資料…" />

  const busyAvatar = saveAvatar.isPending || dropAvatar.isPending
  const dirty = displayName !== data.user.displayName || email !== data.user.email
  const pwReady = currentPassword.length > 0 && newPassword.length >= 8
    && newPassword === confirmPassword

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="mb-6 text-lg font-semibold text-slate-800">帳號設定</h1>

        {/* ── 頭像 ── */}
        <section className="mb-6 rounded-xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">頭像</h2>

          <div className="flex items-center gap-5">
            <Avatar userId={data.user.id} name={data.user.displayName}
                    hasAvatar={!!data.user.avatarFile} version={data.user.avatarFile}
                    size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <AvatarPicker disabled={busyAvatar} onPick={img => saveAvatar.mutate(img)}>
                  {data.user.avatarFile ? '換一張' : '選一張圖'}
                </AvatarPicker>
                {data.user.avatarFile && (
                  <button disabled={busyAvatar} onClick={() => dropAvatar.mutate()}
                          className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50">
                    移除
                  </button>
                )}
                {busyAvatar && <span className="text-xs text-slate-400">處理中…</span>}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                支援 PNG、JPEG、WebP。圖會自動取中間的正方形、縮成 256 見方再上傳。
                沒有頭像時顯示名字算出來的色塊。
              </p>
            </div>
          </div>

          {avatarErr && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {avatarErr}
            </div>
          )}
        </section>

        {/* ── 基本資料 ── */}
        <section className="rounded-xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">基本資料</h2>

          <div className="space-y-3">
            <Field label="顯示名稱">
              <Input value={displayName} maxLength={80}
                     onChange={e => setDisplayName(e.target.value)} />
            </Field>
            <Field label="email（也是登入帳號）">
              <Input value={email} type="email" maxLength={254}
                     onChange={e => setEmail(e.target.value)} />
            </Field>
          </div>

          <p className="mt-2 text-xs text-slate-400">
            改了 email 之後就要用新的 email 登入。站上沒有寄驗證信的機制，改完立刻生效。
          </p>

          {profileErr && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {profileErr}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary"
                    disabled={!dirty || !displayName.trim() || !email.trim() || saveProfile.isPending}
                    onClick={() => saveProfile.mutate()}>儲存</Button>
            {dirty && (
              <button onClick={() => {
                setDisplayName(data.user.displayName)
                setEmail(data.user.email)
                setProfileErr(null); setProfileMsg(null)
              }} className="text-xs text-slate-400 hover:text-slate-600">還原</button>
            )}
            {profileMsg && !dirty && (
              <span className="text-xs text-emerald-600">{profileMsg}</span>
            )}
          </div>
        </section>

        {/* ── 密碼 ── */}
        <section className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">變更密碼</h2>

          <div className="space-y-3">
            <Field label="目前的密碼">
              <Input type="password" value={currentPassword} autoComplete="current-password"
                     onChange={e => setCurrentPassword(e.target.value)} />
            </Field>
            <Field label="新密碼（至少 8 個字元）">
              <Input type="password" value={newPassword} autoComplete="new-password"
                     onChange={e => setNewPassword(e.target.value)} />
            </Field>
            <Field label="再輸入一次新密碼">
              <Input type="password" value={confirmPassword} autoComplete="new-password"
                     onChange={e => setConfirmPassword(e.target.value)} />
            </Field>
          </div>

          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <p className="mt-2 text-xs text-red-600">兩次輸入的新密碼不一樣。</p>
          )}
          <p className="mt-2 text-xs text-slate-400">
            改完密碼所有裝置都要重新登入，包含現在這一台。
          </p>

          {pwErr && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {pwErr}
            </div>
          )}

          <div className="mt-4">
            <Button variant="primary" disabled={!pwReady || changePassword.isPending}
                    onClick={() => changePassword.mutate()}>變更密碼並重新登入</Button>
          </div>
        </section>

        {/* ── 工作區 ── */}
        <section className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">我在哪些工作區</h2>
          <div className="divide-y divide-slate-100">
            {data.workspaces.map(w => (
              <div key={w.id} className="flex items-center gap-3 py-2">
                <span className="flex-1 truncate text-sm text-slate-700">{w.name}</span>
                <span className="text-xs text-slate-500">{ROLE_LABEL[w.role] ?? w.role}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            這裡的角色管的是「誰能登入這個站、誰能開帳號」，跟你在各專案裡的角色是兩回事。
          </p>
        </section>
      </div>
    </div>
  )
}
