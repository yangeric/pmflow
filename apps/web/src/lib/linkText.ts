import type { LinkType } from './api'

/**
 * 關聯類型的中文說法。
 *
 * 資料庫存的仍是 FS / SS / FF / SF 這些代碼（migration 與 API 契約不動），
 * 這裡只負責「講人話」—— 使用者不該需要知道那四個縮寫是什麼意思。
 *
 *   等待任務【完成】，才能【開始】   ← 前半講來源那一端，後半講自己這一端
 *
 * 任務詳情與通知都要講同一句話，所以放在 lib 而不是某個元件裡。
 * （關聯圖 pages/Graph.tsx 另有一套自己的短標籤，那是畫在線上的，字數限制不同。）
 */
export const LINK_LABEL: Record<LinkType, string> = {
  FS: '等待任務完成，才能開始',
  SS: '等待任務開始，才能開始',
  FF: '等待任務完成，才能完成',
  SF: '等待任務開始，才能完成',
  RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
}

/** 清單上的短標籤，空間有限時用 */
export const LINK_CHIP: Record<LinkType, string> = {
  FS: '完成後開始', SS: '同時開始', FF: '同時完成', SF: '開始後完成',
  RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
}

export const SCHEDULING: LinkType[] = ['FS', 'SS', 'FF', 'SF']

export const SEMANTIC: LinkType[] = ['RELATES', 'BLOCKS', 'DUPLICATES', 'REQUIRES']

/**
 * 把一條關聯講成一句完整的話，而且分方向講。
 * 同樣是 FS，站在上游和下游看到的句子不一樣 —— 這是最容易看錯的地方。
 *
 * incoming＝「我」是被指向的那一端，也就是通知裡的視角。
 */
export function linkSentence(
  type: LinkType, direction: 'outgoing' | 'incoming', ref: string
): string {
  const out = direction === 'outgoing'
  switch (type) {
    case 'FS': return out ? `${ref} 要等我完成，才能開始` : `要等 ${ref} 完成，我才能開始`
    case 'SS': return out ? `${ref} 要等我開始，才能開始` : `要等 ${ref} 開始，我才能開始`
    case 'FF': return out ? `${ref} 要等我完成，才能完成` : `要等 ${ref} 完成，我才能完成`
    case 'SF': return out ? `${ref} 要等我開始，才能完成` : `要等 ${ref} 開始，我才能完成`
    case 'RELATES':    return `與 ${ref} 相關`
    case 'BLOCKS':     return out ? `阻擋 ${ref}` : `被 ${ref} 阻擋`
    case 'DUPLICATES': return out ? `重複於 ${ref}` : `被 ${ref} 重複`
    case 'REQUIRES':   return out ? `需要 ${ref}` : `被 ${ref} 需要`
  }
}
