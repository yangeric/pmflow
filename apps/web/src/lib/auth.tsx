import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Api, setAccessToken, type User, type Workspace, api } from './api'

interface AuthState {
  user: User | null
  workspaces: Workspace[]
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [ready, setReady] = useState(false)

  // 開頁時用 httpOnly cookie 換一張 access token，做到「關掉分頁再回來還是登入狀態」。
  // access token 只放在記憶體，不進 localStorage —— XSS 偷不走。
  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ accessToken: string; user: User }>('/auth/refresh', { method: 'POST' }, false)
        setAccessToken(r.accessToken)
        const me = await Api.me()
        setUser(me.user)
        setWorkspaces(me.workspaces)
      } catch { /* 沒登入就算了 */ }
      finally { setReady(true) }
    })()
  }, [])

  const afterAuth = async (accessToken: string, u: User) => {
    setAccessToken(accessToken)
    setUser(u)
    setWorkspaces((await Api.me()).workspaces)
  }

  return (
    <Ctx.Provider value={{
      user, workspaces, ready,
      login: async (email, password) => {
        const r = await Api.login(email, password)
        await afterAuth(r.accessToken, r.user)
      },
      register: async (email, password, displayName) => {
        const r = await Api.register({ email, password, displayName })
        await afterAuth(r.accessToken, r.user)
      },
      logout: async () => {
        await Api.logout().catch(() => {})
        setAccessToken(null)
        setUser(null)
        setWorkspaces([])
      },
    }}>{children}</Ctx.Provider>
  )
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth 必須在 AuthProvider 內使用')
  return v
}
