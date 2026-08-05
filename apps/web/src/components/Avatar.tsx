import { useRef, useState } from 'react'
import { Api } from '../lib/api'
import { cx } from './ui'
import { T } from '../strings'

/**
 * 頭像。有上傳過就顯示圖，沒有就用名字算出來的色塊。
 *
 * 色塊的顏色由名字決定（不是隨機），所以同一個人在清單、成員頁、通知裡
 * 永遠是同一個顏色 —— 掃過去的時候顏色本身就有辨識度。
 */

/**
 * 底色。刻意避開紅（逾期）與綠（已完成），那兩個顏色在這套介面裡有別的意思。
 *
 * 每個顏色配白字都要有 4.5:1 —— 名字的第一個字是辨識這個人的唯一線索，
 * 讀不出來就等於沒有頭像。原本的青（#0891b2）與藍綠（#0d9488）只有 3.68 與 3.74，
 * 各往深一階換成 cyan-700 / teal-700（5.36 / 5.47）。
 */
const COLORS = [
  '#3178c6', '#7c3aed', '#0e7490', '#c2410c', '#4f46e5',
  '#0f766e', '#9333ea', '#b45309', '#1d4ed8', '#be185d',
]

function hueOf(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return COLORS[h % COLORS.length]
}

/** 中文取最後一個字（名），英文取第一個字母 */
export function initialOf(name: string): string {
  const t = name.trim()
  if (!t) return '？'
  return /[A-Za-z]/.test(t[0]) ? t[0].toUpperCase() : t.slice(-1)
}

const SIZES = {
  sm: 'h-5 w-5 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-20 w-20 text-2xl',
} as const

export function Avatar({ userId, name, hasAvatar, size = 'sm', version, className }: {
  userId: string | null
  name: string | null
  hasAvatar?: boolean
  size?: keyof typeof SIZES
  /** 換過頭像之後帶新的值進來，才不會拿到瀏覽器快取的舊圖 */
  version?: string | null
  className?: string
}) {
  // 圖讀不到就退回色塊 —— 檔案可能因為換機器、volume 沒掛而不見了，
  // 那不該讓畫面上出現一個破圖
  const [broken, setBroken] = useState(false)
  const label = name ?? T.common.unassigned
  const base = cx(
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
    SIZES[size], className
  )

  if (userId && hasAvatar && !broken) {
    return (
      <img src={Api.avatarUrl(userId, version)} alt={label} title={label}
           onError={() => setBroken(true)}
           className={cx(base, 'bg-slate-100 object-cover dark:bg-slate-800')} />
    )
  }
  return (
    <span className={cx(base, 'font-medium text-white')} title={label}
          style={{ background: name ? hueOf(name) : '#cbd5e1' }} aria-hidden>
      {name ? initialOf(name) : '—'}
    </span>
  )
}

/**
 * 選圖 → 縮到 256 見方 → 交出 data URL。
 *
 * 縮圖在瀏覽器做，不在後端：省掉一個影像處理相依（那類套件多半有原生模組，
 * 跨架構建置會很麻煩，見 Dockerfile 的說明），而且使用者選了一張 8MB 的相片時，
 * 上傳的是縮好的幾十 KB，不是原檔。
 *
 * 裁切方式是「取中間的正方形」—— 頭像是圓的，長方形的圖直接塞進去會被壓扁。
 */
export function AvatarPicker({ onPick, disabled, children }: {
  onPick: (dataUrl: string) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={async e => {
          const file = e.target.files?.[0]
          e.target.value = ''            // 選同一張圖兩次也要觸發
          if (!file) return
          onPick(await toSquareDataUrl(file))
        }}
      />
      <button type="button" disabled={disabled} onClick={() => ref.current?.click()}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm
                         font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50
                         dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300
                         dark:hover:bg-slate-800">
        {children}
      </button>
    </>
  )
}

const SIDE = 256

async function toSquareDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = SIDE
  canvas.height = SIDE
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, SIDE, SIDE
  )
  bitmap.close()
  // 一律轉成 JPEG：PNG 的頭像常常是幾百 KB，同樣尺寸的 JPEG 只有幾十 KB，
  // 而頭像不需要透明背景
  return canvas.toDataURL('image/jpeg', 0.85)
}
