import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * 深色模式。
 *
 * 三個選項：跟隨系統、淺色、深色。**預設是跟隨系統** —— 使用者在作業系統上
 * 已經表達過一次偏好了，再逼他選一次沒有意義；而「跟隨系統」也是唯一會在
 * 天黑時自己換過去的選項。
 *
 * 存在 localStorage 不存在後端：這是「這台裝置上看起來怎樣」，不是帳號屬性。
 * 同一個人在辦公室的螢幕想要淺色、在家的筆電想要深色，是很正常的事，
 * 存進帳號反而會互相蓋掉。代價是換一台電腦要再選一次，那不痛。
 *
 * 畫面上的深色樣式一律寫成 `dark:` 前綴，靠 <html> 上的 `dark` class 打開，
 * 對照表在 index.css 最上面。
 */

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'pmflow.theme'

function isChoice(v: unknown): v is ThemeChoice {
  return v === 'light' || v === 'dark' || v === 'system'
}

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return isChoice(v) ? v : 'system'
  } catch {
    // 隱私模式下 localStorage 會直接丟例外，那就當作沒設定過
    return 'system'
  }
}

const prefersDark = () =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

export const resolveTheme = (choice: ThemeChoice): 'light' | 'dark' =>
  choice === 'system' ? (prefersDark() ? 'dark' : 'light') : choice

/**
 * 真正動到畫面的地方。除了掛 class，也要設 color-scheme ——
 * 捲軸、下拉選單、日期選擇器那些瀏覽器自己畫的東西只認它，不認 class。
 */
export function applyTheme(choice: ThemeChoice): void {
  const dark = resolveTheme(choice) === 'dark'
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

/**
 * 在 React 掛載之前先套一次，不然第一格畫面會閃一下白的。
 * main.tsx 進入點就會呼叫。
 */
export function applyStoredTheme(): void {
  applyTheme(storedTheme())
}

const ThemeContext = createContext<{
  choice: ThemeChoice
  resolved: 'light' | 'dark'
  setChoice: (c: ThemeChoice) => void
} | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => storedTheme())
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(storedTheme()))

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c)
    setResolved(resolveTheme(c))
    applyTheme(c)
    try {
      localStorage.setItem(KEY, c)
    } catch {
      // 存不進去就只有這次有效，不值得為它中斷操作
    }
  }

  // 選「跟隨系統」的人，天黑時作業系統自己換過去，畫面要跟著換
  useEffect(() => {
    if (choice !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { applyTheme('system'); setResolved(resolveTheme('system')) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const v = useContext(ThemeContext)
  if (!v) throw new Error('useTheme 必須放在 ThemeProvider 底下')
  return v
}
