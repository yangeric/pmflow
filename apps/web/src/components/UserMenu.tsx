import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api } from '../lib/api'
import { useTheme, type ThemeChoice } from '../lib/theme'
import { T } from '../strings'
import { useAuth } from '../lib/auth'
import { Avatar } from './Avatar'
import { Button, cx } from './ui'

/**
 * 右上角的頭像選單。
 *
 * 帳號設定、系統管理、外觀、登出這些「跟目前在看什麼無關」的功能，
 * 原本散在側欄底部與各頁的角落。它們的共同點是**都跟「我這個人」有關**，
 * 所以收進頭像底下：右上角的頭像是所有人第一個會去點的地方，
 * 而版面上少四個常駐按鈕，留給真正在做的事。
 *
 * 外觀直接做在選單裡、不塞進帳號設定頁：切深色是隨手要做的事，
 * 為了它多走兩層畫面不合理。
 */

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; icon: string }> = [
  { value: 'light', label: T.account.menu.themeLight, icon: '☀' },
  { value: 'dark', label: T.account.menu.themeDark, icon: '☾' },
  { value: 'system', label: T.account.menu.themeSystem, icon: '💻' },
]

export function UserMenu({
  userName, isWorkspaceAdmin, onAccount, onAdmin, onLogout, onMembers, onSettings,
  pendingJoins = 0,
}: {
  userName: string
  isWorkspaceAdmin: boolean
  onAccount: () => void
  onAdmin: () => void
  onLogout: () => void
  /**
   * 專案成員。**只有人在專案裡的時候才會傳進來** ——
   * 成員講的是「這個專案的成員」，在專案選擇頁沒有專案可言，那時就不畫這一項。
   */
  onMembers?: () => void
  /**
   * 這個專案的系統參數（狀態／優先度／類型）。跟成員同一區，也同一個規矩：
   * 人在專案裡才傳進來，而且**只有專案的管理者才會拿到** ——
   * 其他人看得到清單也改不了，畫一個按了會被拒絕的入口沒有意義。
   */
  onSettings?: () => void
  /** 待審的加入申請數。不是建立者的話後端一律回 0 */
  pendingJoins?: number
}) {
  const [open, setOpen] = useState(false)
  const [showSwitchModal, setShowSwitchModal] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { choice, setChoice } = useTheme()
  const { switchUser } = useAuth()

  // 頭像與 email 都在這支查詢裡，而且帳號設定頁也用同一把 key，改完頭像這裡跟著換
  const { data } = useQuery({ queryKey: ['myProfile'], queryFn: () => Api.myProfile() })
  const me = data?.user

  const currentWsId = data?.workspaces[0]?.id
  const { data: adminUsersData } = useQuery({
    queryKey: ['adminUsers', currentWsId],
    queryFn: () => currentWsId ? Api.adminUsers(currentWsId) : Promise.resolve({ users: [], myRole: 'MEMBER' as const, roles: [] }),
    enabled: !!currentWsId && showSwitchModal,
  })

  // 點到外面、按 Esc 都要收起來 —— 選單蓋在內容上，關不掉會擋住畫面
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (fn: () => void) => () => { setOpen(false); fn() }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        title={userName}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx(
          'rounded-full ring-2 transition',
          open ? 'ring-blue-500' : 'ring-transparent hover:ring-slate-300 dark:hover:ring-slate-600'
        )}>
        <Avatar userId={me?.id ?? null} name={userName}
                hasAvatar={!!me?.avatarFile} version={me?.avatarFile} size="md" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl bg-white py-1
                     shadow-lg ring-1 ring-slate-200
                     dark:bg-slate-800 dark:ring-slate-700">
          <div className="flex items-center gap-2.5 px-3 py-2">
            <Avatar userId={me?.id ?? null} name={userName}
                    hasAvatar={!!me?.avatarFile} version={me?.avatarFile} size="md" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                {userName}
              </div>
              {me?.email && (
                <div className="truncate text-xs text-slate-400 dark:text-slate-400">{me.email}</div>
              )}
            </div>
          </div>

          <div className="my-1 border-t border-slate-100 dark:border-slate-700" />

          {/*
            成員與系統參數跟底下那些是不同性質的東西：這一區是「目前這個專案」的
            設定，下面講的是「我這個人」，所以中間隔一條線。
          */}
          {(onMembers || onSettings) && (
            <>
              {onMembers && (
                <MenuItem onClick={go(onMembers)}>
                  <span className="flex items-center gap-2">
                    {T.nav.members}
                    {pendingJoins > 0 && (
                      <span title={T.nav.pendingJoinsHint(pendingJoins)}
                            className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">
                        {pendingJoins}
                      </span>
                    )}
                  </span>
                </MenuItem>
              )}
              {onSettings && (
                <MenuItem onClick={go(onSettings)}>{T.settings.menuEntry}</MenuItem>
              )}
              <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
            </>
          )}

          <MenuItem onClick={go(onAccount)}>{T.account.menu.account}</MenuItem>
          {isWorkspaceAdmin && <MenuItem onClick={go(onAdmin)}>{T.account.menu.admin}</MenuItem>}

          {/* 擁有者/管理者專屬：測試代理切換身份 */}
          {isWorkspaceAdmin && (
            <MenuItem onClick={go(() => setShowSwitchModal(true))}>
              <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400 font-medium">
                <span>🔀</span> 切換測試身份 (代理帳號)
              </span>
            </MenuItem>
          )}

          <div className="my-1 border-t border-slate-100 dark:border-slate-700" />

          <div className="px-3 py-1.5">
            <div className="mb-1.5 text-xs font-medium text-slate-400 dark:text-slate-400">{T.account.menu.appearance}</div>
            <div className="flex gap-1">
              {THEME_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setChoice(o.value)}
                  title={o.label}
                  className={cx(
                    'flex flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[11px]',
                    'transition-colors',
                    choice === o.value
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                      : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700'
                  )}>
                  <span aria-hidden className="text-sm">{o.icon}</span>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="my-1 border-t border-slate-100 dark:border-slate-700" />

          <MenuItem onClick={go(onLogout)} danger>{T.account.menu.logout}</MenuItem>
        </div>
      )}

      {showSwitchModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <span>🔀</span> 切換測試身份 (代理帳號)
              </h3>
              <button
                onClick={() => setShowSwitchModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              做為擁有者/管理者，您可以免密碼直接代理切換為以下任一帳號進行權限與功能測試：
            </p>
            <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
              {(adminUsersData?.users ?? []).map(u => (
                <div
                  key={u.id}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200/60 dark:border-slate-600/40 transition">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar userId={u.id} name={u.displayName} size="md" />
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
                        {u.displayName} {u.id === me?.id && <span className="text-xs text-blue-500 font-normal">(目前帳號)</span>}
                      </div>
                      <div className="text-xs text-slate-400 truncate">{u.email}</div>
                    </div>
                  </div>
                  {u.id !== me?.id && (
                    <Button
                      variant="primary"
                      className="px-3 py-1 text-xs"
                      onClick={async () => {
                        setShowSwitchModal(false)
                        await switchUser(u.id)
                      }}>
                      切換
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end">
              <Button variant="default" onClick={() => setShowSwitchModal(false)}>
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children, onClick, danger,
}: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cx(
        'block w-full px-3 py-1.5 text-left text-sm transition-colors',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'
      )}>
      {children}
    </button>
  )
}
