import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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

  const qc = useQueryClient()

  /**
   * 換帳號時把整份查詢快取丟掉。
   *
   * 少了這一步，登出再用另一個帳號登入，畫面上還是前一個人的專案與任務 ——
   * TanStack Query 的快取是跟著 queryKey 走的，不會因為換人就失效，而
   * ['projects']、['tasks', id] 這些鍵裡沒有使用者。伺服器那邊擋得住
   * （拿新 token 去要就是 403），但在重新抓到之前，畫面已經把上一個人的
   * 東西顯示出來了。共用電腦上這是不能接受的。
   */
  const resetCache = () => qc.clear()

  const afterAuth = async (accessToken: string, u: User) => {
    resetCache()
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
        resetCache()
      },
    }}>{children}</Ctx.Provider>
  )
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth 必須在 AuthProvider 內使用')
  return v
}
