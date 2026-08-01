import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react'
import type { InquiryState } from '../lib/api'

export const cx = (...s: Array<string | false | null | undefined>) => s.filter(Boolean).join(' ')

export function Button({
  variant = 'default', className, ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    default: 'bg-white border border-slate-300 hover:bg-slate-50 text-slate-700',
    primary: 'bg-blue-600 hover:bg-blue-700 text-white border border-blue-600',
    ghost: 'hover:bg-slate-100 text-slate-600 border border-transparent',
    danger: 'bg-white border border-red-300 text-red-600 hover:bg-red-50',
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
        'focus:border-blue-500', className
      )}
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
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
  AWAITING: { label: '待回覆',   cls: 'bg-blue-50 text-blue-700 ring-blue-600/20',      icon: '⏳' },
  OVERDUE:  { label: '逾期未回', cls: 'bg-red-50 text-red-700 ring-red-600/20',         icon: '⚠️' },
  PARTIAL:  { label: '部分已回', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20',   icon: '◐' },
  REPLIED:  { label: '已回覆',   cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', icon: '✓' },
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

export function Spinner({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      {label}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-400">{children}</div>
}
