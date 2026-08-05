import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Api, ApiError, type ApiToken } from '../lib/api'
import { useAuth } from '../lib/auth'
import { todayYmd } from '../lib/date'
import { T } from '../strings'
import { Button, Field, Input, Spinner } from './ui'
import { Avatar, AvatarPicker } from './Avatar'

/**
 * 自己的帳號設定。
 *
 * 只做五件事：換頭像、改顯示名稱、改 email、改密碼、管理 API 權杖。
 * 刻意不做通知偏好、兩階段驗證 —— 這個站沒有寄信的能力，做了也走不完流程。
 *
 * 改密碼會把**所有裝置**的登入作廢，包含現在這一台（後端會把 refresh token
 * 全部撤掉）。與其讓使用者在下次開頁時莫名被登出，不如當場登出、當場重登，
 * 至少他知道發生了什麼事。
 */

const errText = (e: unknown) =>
  e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : T.common.failed

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
      setProfileMsg(T.common.saved)
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

  if (isLoading || !data) return <Spinner label={T.account.loading} />

  const busyAvatar = saveAvatar.isPending || dropAvatar.isPending
  const dirty = displayName !== data.user.displayName || email !== data.user.email
  const pwReady = currentPassword.length > 0 && newPassword.length >= 8
    && newPassword === confirmPassword

  return (
    <div className="h-full overflow-auto bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="mb-6 text-lg font-semibold text-slate-800 dark:text-slate-100">
          {T.account.title}
        </h1>

        {/* ── 頭像 ── */}
        <section className="mb-6 rounded-xl bg-white p-5 ring-1 ring-slate-200
                            dark:bg-slate-900 dark:ring-slate-700">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
            {T.account.avatar.title}
          </h2>

          <div className="flex items-center gap-5">
            <Avatar userId={data.user.id} name={data.user.displayName}
                    hasAvatar={!!data.user.avatarFile} version={data.user.avatarFile}
                    size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <AvatarPicker disabled={busyAvatar} onPick={img => saveAvatar.mutate(img)}>
                  {data.user.avatarFile ? T.account.avatar.replace : T.account.avatar.pick}
                </AvatarPicker>
                {data.user.avatarFile && (
                  <button disabled={busyAvatar} onClick={() => dropAvatar.mutate()}
                          className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50
                                     dark:text-slate-400 dark:hover:text-slate-300">
                    {T.common.remove}
                  </button>
                )}
                {busyAvatar && (
                  <span className="text-xs text-slate-400 dark:text-slate-400">
                    {T.account.avatar.working}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">
                {T.account.avatar.hint}
              </p>
            </div>
          </div>

          {avatarErr && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700
                            dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
              {avatarErr}
            </div>
          )}
        </section>

        {/* ── 基本資料 ── */}
        <section className="rounded-xl bg-white p-5 ring-1 ring-slate-200
                            dark:bg-slate-900 dark:ring-slate-700">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
            {T.account.profile.title}
          </h2>

          <div className="space-y-3">
            <Field label={T.account.profile.displayName}>
              <Input value={displayName} maxLength={80}
                     onChange={e => setDisplayName(e.target.value)} />
            </Field>
            <Field label={T.account.profile.email}>
              <Input value={email} type="email" maxLength={254}
                     onChange={e => setEmail(e.target.value)} />
            </Field>
          </div>

          <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">
            {T.account.profile.hint}
          </p>

          {profileErr && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700
                            dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
              {profileErr}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary"
                    disabled={!dirty || !displayName.trim() || !email.trim() || saveProfile.isPending}
                    onClick={() => saveProfile.mutate()}>{T.common.save}</Button>
            {dirty && (
              <button onClick={() => {
                setDisplayName(data.user.displayName)
                setEmail(data.user.email)
                setProfileErr(null); setProfileMsg(null)
              }} className="text-xs text-slate-400 hover:text-slate-600
                            dark:text-slate-400 dark:hover:text-slate-300">{T.common.restore}</button>
            )}
            {profileMsg && !dirty && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">{profileMsg}</span>
            )}
          </div>
        </section>

        {/* ── 密碼 ── */}
        <section className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200
                            dark:bg-slate-900 dark:ring-slate-700">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
            {T.account.password.title}
          </h2>

          <div className="space-y-3">
            <Field label={T.account.password.current}>
              <Input type="password" value={currentPassword} autoComplete="current-password"
                     onChange={e => setCurrentPassword(e.target.value)} />
            </Field>
            <Field label={T.account.password.next}>
              <Input type="password" value={newPassword} autoComplete="new-password"
                     onChange={e => setNewPassword(e.target.value)} />
            </Field>
            <Field label={T.account.password.again}>
              <Input type="password" value={confirmPassword} autoComplete="new-password"
                     onChange={e => setConfirmPassword(e.target.value)} />
            </Field>
          </div>

          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {T.account.password.mismatch}
            </p>
          )}
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">
            {T.account.password.hint}
          </p>

          {pwErr && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700
                            dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
              {pwErr}
            </div>
          )}

          <div className="mt-4">
            <Button variant="primary" disabled={!pwReady || changePassword.isPending}
                    onClick={() => changePassword.mutate()}>{T.account.password.submit}</Button>
          </div>
        </section>

        {/* ── API 權杖 ── */}
        <ApiTokenSection />

        {/* ── 工作區 ── */}
        <section className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200
                            dark:bg-slate-900 dark:ring-slate-700">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
            {T.account.workspaces.title}
          </h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.workspaces.map(w => (
              <div key={w.id} className="flex items-center gap-3 py-2">
                <span className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">
                  {w.name}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {T.account.workspaceRole[w.role] ?? w.role}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">
            {T.account.workspaces.hint}
          </p>
        </section>
      </div>
    </div>
  )
}

/** 給人看的時間戳。權杖這一區只在乎「大概什麼時候」，不需要秒 */
function stamp(s: string | null): string {
  if (!s) return T.common.none
  const d = new Date(s)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * API 權杖：讓外部系統代替你呼叫這個站的 API。
 *
 * 拿權杖呼叫等於你本人在呼叫，所以這裡沒有任何權限設定可以調 ——
 * 能不能建某個專案的任務，看的仍然是你在那個專案裡的角色。
 *
 * 建立完成後的明文是一個**獨立的畫面狀態**，不是清單的一部分：伺服器只存雜湊，
 * 重新整理就再也拿不回來。所以明文出現後不會自己消失，要使用者自己按「我收好了」，
 * 免得他手滑重整就得重發一把。
 */
function ApiTokenSection() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['myApiTokens'], queryFn: () => Api.apiTokens(),
  })

  const [name, setName] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => Api.createApiToken({
      name: name.trim(), expiresOn: expiresOn || null,
    }),
    onSuccess: async r => {
      setErr(null); setCopied(false); setPlaintext(r.plaintext)
      setName(''); setExpiresOn('')
      await refetch()
    },
    onError: e => setErr(errText(e)),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => Api.revokeApiToken(id),
    onSuccess: async () => { setErr(null); await refetch() },
    onError: e => setErr(errText(e)),
  })

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // 沒有剪貼簿權限（非 https 的內網就會這樣）時不當成錯誤，
      // 反正明文就在畫面上，使用者自己選取複製即可
      setCopied(false)
    }
  }

  const tokens: ApiToken[] = data?.tokens ?? []
  const today = todayYmd()

  return (
    <section className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200
                        dark:bg-slate-900 dark:ring-slate-700">
      <h2 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">
        {T.account.token.title}
      </h2>
      <p className="mb-4 text-xs text-slate-400 dark:text-slate-400">
        {T.account.token.hint}
      </p>

      {/* 明文只會出現這一次，所以給它整段最醒目的位置 */}
      {plaintext && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3
                        dark:border-amber-500/30 dark:bg-amber-500/15">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
            {T.account.token.plaintextWarning}
          </p>
          <code className="mt-2 block break-all rounded bg-white px-2.5 py-2 font-mono text-xs
                           text-slate-800 ring-1 ring-amber-200
                           dark:bg-slate-950 dark:text-slate-100 dark:ring-amber-500/30">
            {plaintext}
          </code>
          <div className="mt-2 flex items-center gap-3">
            <Button onClick={() => copy(plaintext)}>{T.account.token.copy}</Button>
            <button onClick={() => { setPlaintext(null); setCopied(false) }}
                    className="text-xs text-slate-500 hover:text-slate-700
                               dark:text-slate-400 dark:hover:text-slate-200">
              {T.account.token.dismiss}
            </button>
            {copied && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {T.account.token.copied}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 建立 ── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <Field label={T.account.token.name}>
            <Input value={name} maxLength={80} placeholder={T.account.token.namePlaceholder}
                   onChange={e => setName(e.target.value)} />
          </Field>
        </div>
        <div className="w-44">
          <Field label={T.account.token.expiresOn}>
            <Input type="date" value={expiresOn} min={today}
                   onChange={e => setExpiresOn(e.target.value)} />
          </Field>
        </div>
        <Button variant="primary" disabled={!name.trim() || create.isPending}
                onClick={() => create.mutate()}>{T.account.token.create}</Button>
      </div>
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-400">
        {T.account.token.createHint}
      </p>

      {err && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700
                        dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
          {err}
        </div>
      )}

      {/* ── 清單 ── */}
      <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
        {isLoading ? (
          <Spinner label={T.account.token.loading} />
        ) : tokens.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400 dark:text-slate-400">
            {T.account.token.empty}
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {tokens.map(t => {
              const expired = !!t.expiresOn && t.expiresOn < today
              return (
                <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-slate-700 dark:text-slate-300">
                        {t.name}
                      </span>
                      {expired && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500
                                         dark:bg-slate-800 dark:text-slate-400">
                          {T.account.token.expired}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-400">
                      <code className="font-mono">{t.prefix}…</code>
                      <span className="mx-2">·</span>
                      {T.account.token.createdAt(stamp(t.createdAt))}
                      <span className="mx-2">·</span>
                      {T.account.token.lastUsedAt(
                        t.lastUsedAt ? stamp(t.lastUsedAt) : T.account.token.neverUsed
                      )}
                      <span className="mx-2">·</span>
                      {t.expiresOn ? T.account.token.until(t.expiresOn) : T.account.token.noExpiry}
                    </div>
                  </div>
                  <Button variant="danger" disabled={revoke.isPending}
                          onClick={() => {
                            if (confirm(T.account.token.confirmRevoke(t.name))) {
                              revoke.mutate(t.id)
                            }
                          }}>{T.account.token.revoke}</Button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
