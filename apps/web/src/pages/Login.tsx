import { useEffect, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../lib/auth'
import { Button, Input, Field } from '../components/ui'
import { ProviderIcon } from '../components/ProviderIcon'
import { T } from '../strings'
import { Api, ApiError } from '../lib/api'

export default function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('demo@pmflow.local')
  const [password, setPassword] = useState('demo1234')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 站台有沒有開放 Google／Apple 登入。
   *
   * **設定不齊的那一家後端根本不會回**，所以這裡不必判斷任何東西 ——
   * 清單是空的就不畫。查詢失敗（例如後端沒起來）也一樣當成沒有：
   * 這一區是加分項，不該讓密碼登入跟著看不到。
   */
  const { data: providers } = useQuery({
    queryKey: ['oauthProviders'],
    queryFn: () => Api.oauthProviders(),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const external = providers?.providers ?? []

  /**
   * 用外部帳號登入失敗時，後端會把原因放在網址上導回這裡
   * （那一趟是整頁跳轉，沒有辦法用回傳值把訊息帶回來）。
   * 讀完立刻把網址清乾淨 —— 不然使用者重新整理會再看到同一句話，
   * 而且那句話會跟著被複製、被加進書籤。
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const failed = params.get('loginError')
    if (!failed) return
    setError(failed)
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password, displayName)
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : T.nav.login.connectFailed)
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
      <form onSubmit={submit}
            className="w-full max-w-sm rounded-xl bg-white p-7 shadow-sm ring-1 ring-slate-200
                       dark:bg-slate-900 dark:ring-slate-700">
        <div className="mb-1 text-xl font-semibold text-slate-800 dark:text-slate-100">
          {T.nav.appName}
        </div>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
          {mode === 'login' ? T.nav.login.subtitleLogin : T.nav.login.subtitleRegister}
        </p>

        <div className="space-y-3">
          {mode === 'register' && (
            <Field label={T.nav.login.displayName}>
              <Input value={displayName} onChange={e => setDisplayName(e.target.value)}
                     required maxLength={80} placeholder={T.nav.login.displayNamePlaceholder} />
            </Field>
          )}
          <Field label={T.nav.login.email}>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
          </Field>
          <Field label={T.nav.login.password}>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)}
                   required minLength={8}
                   autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200
                          dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30">
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center">
          {busy ? T.nav.login.submitting : mode === 'login' ? T.nav.login.login : T.nav.login.register}
        </Button>

        {/*
          用 Google／Apple 的帳號登入。整頁跳轉出去，回來時後端已經發好
          refresh cookie，前端一開頁就會拿它去換 access token —— 跟密碼登入
          走的是同一段程式，所以這裡不需要處理任何權杖。
          用 <a> 不用 <button>：它就是「離開這一頁去別的網站」，
          中鍵開新分頁、看得到目的地網址這些行為都該照瀏覽器原本的來。
        */}
        {external.length > 0 && (
          <>
            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              <span className="text-xs text-slate-400 dark:text-slate-400">
                {T.nav.login.externalDivider}
              </span>
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>

            <div className="space-y-2">
              {external.map(p => (
                <a key={p.id} href={Api.oauthStartUrl(p.id)}
                   className="flex w-full items-center justify-center gap-2 rounded-md border
                              border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700
                              transition-colors hover:bg-slate-50
                              focus:outline-none focus:ring-2 focus:ring-blue-500/40
                              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200
                              dark:hover:bg-slate-700">
                  <ProviderIcon provider={p.id} />
                  {T.nav.login.withProvider(p.label)}
                </a>
              ))}
            </div>

            <p className="mt-3 text-xs leading-relaxed text-slate-400 dark:text-slate-400">
              {T.nav.login.externalHint}
            </p>
          </>
        )}

        <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}
                className="mt-4 w-full text-center text-sm text-blue-600 hover:underline dark:text-blue-400">
          {mode === 'login' ? T.nav.login.toRegister : T.nav.login.toLogin}
        </button>

        {mode === 'login' && (
          <p className="mt-5 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500
                        dark:bg-slate-800 dark:text-slate-400">
            {T.nav.login.demoHint}
          </p>
        )}
      </form>
    </div>
  )
}
