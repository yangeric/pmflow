import { useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import { Button, Input, Field } from '../components/ui'
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
      setError(err instanceof ApiError ? (err.detail ?? err.title) : '連線失敗，請確認後端是否啟動')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-7 shadow-sm ring-1 ring-slate-200">
        <div className="mb-1 text-xl font-semibold text-slate-800">PMFlow</div>
        <p className="mb-6 text-sm text-slate-500">
          {mode === 'login' ? '登入你的工作區' : '建立新帳號'}
        </p>

        <div className="space-y-3">
          {mode === 'register' && (
            <Field label="顯示名稱">
              <Input value={displayName} onChange={e => setDisplayName(e.target.value)}
                     required maxLength={80} placeholder="王小明" />
            </Field>
          )}
          <Field label="Email">
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
          </Field>
          <Field label="密碼">
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)}
                   required minLength={8}
                   autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center">
          {busy ? '處理中…' : mode === 'login' ? '登入' : '註冊'}
        </Button>

        <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}
                className="mt-4 w-full text-center text-sm text-blue-600 hover:underline">
          {mode === 'login' ? '還沒有帳號？註冊一個' : '已經有帳號了？登入'}
        </button>

        {mode === 'login' && (
          <p className="mt-5 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
            示範帳號已經幫你填好了，直接按登入就能看到含甘特、看板與發文追蹤的示範資料。
          </p>
        )}
      </form>
    </div>
  )
}
