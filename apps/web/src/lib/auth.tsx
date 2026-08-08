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
  refreshUser: () => Promise<void>
  switchUser: (targetUserId: string) => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [ready, setReady] = useState(false)

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
      switchUser: async (targetUserId: string) => {
        const r = await Api.impersonate(targetUserId)
        await afterAuth(r.accessToken, r.user)
      },
      logout: async () => {
        await Api.logout().catch(() => {})
        setAccessToken(null)
        setUser(null)
        setWorkspaces([])
        resetCache()
      },
      refreshUser: async () => {
        const me = await Api.me()
        setUser(me.user)
        setWorkspaces(me.workspaces)
      },
    }}>{children}</Ctx.Provider>
  )
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth 必須在 AuthProvider 內使用')
  return v
}
