import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react'
import type { InquiryState } from '../lib/api'

export const cx = (...s: Array<string | false | null | undefined>) => s.filter(Boolean).join(' ')

export function Button({
  variant = 'default', className, ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    default: 'bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 '
      + 'dark:bg-slate-800 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700',
    // 主要按鈕在深色底下要稍微亮一點，不然藍色會沉進背景裡
    primary: 'bg-blue-600 hover:bg-blue-700 text-white border border-blue-600 '
      + 'dark:bg-blue-500 dark:hover:bg-blue-400 dark:border-blue-500',
    ghost: 'hover:bg-slate-100 text-slate-600 border border-transparent '
      + 'dark:text-slate-300 dark:hover:bg-slate-800',
    danger: 'bg-white border border-red-300 text-red-600 hover:bg-red-50 '
      + 'dark:bg-slate-800 dark:border-red-500/50 dark:text-red-400 dark:hover:bg-red-500/10',
  }[variant]
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
        styles, className
      )}
    />
  )
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={cx(
        'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm',
        'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40',
        'focus:border-blue-500',
        'dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100',
        'dark:placeholder:text-slate-500', className
      )}
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </label>
  )
}

/**
 * 發文追蹤徽章 —— 這是整個系統最常被看到的元件。
 * 卡片、清單、甘特上都掛這個，一眼看出「誰還沒回、逾期幾天」。
 */
export const INQUIRY_META: Record<InquiryState, { label: string; cls: string; icon: string }> = {
  NONE:     { label: '',         cls: '',                                              icon: '' },
  AWAITING: { label: '待回覆',   cls: 'bg-blue-50 text-blue-700 ring-blue-600/20 '
    + 'dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/30',                   icon: '⏳' },
  OVERDUE:  { label: '逾期未回', cls: 'bg-red-50 text-red-700 ring-red-600/20 '
    + 'dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30',                      icon: '⚠️' },
  PARTIAL:  { label: '部分已回', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20 '
    + 'dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30',                icon: '◐' },
  REPLIED:  { label: '已回覆',   cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 '
    + 'dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30',          icon: '✓' },
}

export function InquiryBadge({ state, detail }: { state: InquiryState; detail?: string }) {
  if (state === 'NONE') return null
  const m = INQUIRY_META[state]
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
      m.cls
    )}>
      <span aria-hidden>{m.icon}</span>{detail ?? m.label}
    </span>
  )
}

/**
 * 「目前遇到的問題」標記 —— 清單、看板、關聯圖共用同一個長相。
 *
 * 刻意不跟關聯圖的「卡住」共用顏色與符號：卡住是系統依任務關聯算出來的
 * （紅色🚧，上游一完成它自己就不見），這個是人打字寫下的，只有人能清掉。
 * 同一張任務常常兩個都掛著，長得一樣就分不出畫面在講哪一件事。
 *
 * 標記上只放三個字，寫了什麼留給游標停著看 ——
 * 問題通常是一整句話，塞進卡片與節點只會把標題擠掉。
 */
export function ProblemBadge({ problem }: { problem: string | null | undefined }) {
  if (!problem) return null
  return (
    <span
      title={`目前遇到的問題：${problem}`}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]
                 font-medium text-fuchsia-700 ring-1 ring-inset ring-fuchsia-600/20
                 bg-fuchsia-50
                 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-400/30">
      <span aria-hidden>⚑</span>有問題
    </span>
  )
}

export function Spinner({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-400 dark:text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600
                       dark:border-slate-600 dark:border-t-blue-400" />
      {label}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-400 dark:text-slate-500">{children}</div>
}
