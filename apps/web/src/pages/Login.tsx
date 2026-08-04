import { useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import { Button, Input, Field } from '../components/ui'
import { T } from '../strings'
import { ApiError } from '../lib/api'

export default function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('demo@pmflow.local')
  const [password, setPassword] = useState('demo1234')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
