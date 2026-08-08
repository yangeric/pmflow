import type { ProjectParam } from './api'

/**
 * 任務種類的上下關係 —— 前端這一份只負責「不要把不合法的選項畫出來」。
 *
 * **真正的守門員在後端**（`apps/api/src/lib/hierarchy.ts`），這裡擋不住的東西
 * 那邊一定會擋。兩份要一起改：這份漏了只是畫面上多出一個按了會被拒絕的選項，
 * 後端漏了才是真的會寫進資料庫。
 *
 * 規則（使用者 2026-08-05 定，寫在 `D:\NewProject\AGENTS.md`）：
 * - **大項目一定在任務上面**：只能放最上層，或掛在另一個大項目底下。
 * - **錯誤只能在任務下面**：上層一定要是任務。
 * - **任務與里程碑不能站在最上層**（掛在另一張任務底下就是子任務，可以）。
 * - 專案自己新增的種類（key 不是這四種）完全不受限制。
 */

const EPIC = 'EPIC'
const BUG = 'BUG'

/** 這幾個 key 才受規則管。專案自己加的種類不在裡面，所以一律放行 */
const RULED = new Set([EPIC, BUG, 'TASK', 'MILESTONE'])

/**
 * 某一種種類能不能掛在 `parentType` 底下。
 * `parentType` 為 null 代表放在最上層（沒有上層任務）。
 */
export function canBeUnder(type: string, parentType: string | null): boolean {
  if (type === EPIC) {
    // 最上層可以；掛在另一個大項目底下也可以；掛在自訂種類底下不管
    return parentType === null || parentType === EPIC || !RULED.has(parentType)
  }
  if (type === BUG) {
    // 一定要有上層，而且那個上層一定是任務
    return parentType === 'TASK'
  }
  if (type === 'TASK' || type === 'MILESTONE') {
    // 允許放在最上層 (parentType === null)，或掛在其他項目底下
    return true
  }
  return true
}

/**
 * 在 `parentType` 底下新增任務時，可以選哪幾種。
 *
 * 一種都不剩的情況不會發生（任務與里程碑永遠合法），所以呼叫端不必處理空陣列。
 */
export function typesAllowedUnder(
  types: ProjectParam[], parentType: string | null
): ProjectParam[] {
  return types.filter(t => canBeUnder(t.key, parentType))
}

/**
 * 改**既有**任務的種類時，可以選哪幾種。
 *
 * 除了自己的上層，還要看**底下已經掛了什麼** —— 把一張任務改成大項目的話，
 * 原本掛在它底下的問題就變成「掛在大項目底下」，那是不合法的。
 *
 * `current` 一定會留在清單裡，即使它現在不合法。既有資料可能違反這條規則
 * （規則是後來才定的），拿掉的話下拉會顯示空白，然後他一存檔就把種類
 * 靜悄悄換成別的 —— 那比顯示一個不合規的值糟得多。
 */
export function typesAllowedFor(
  types: ProjectParam[],
  opts: { current: string; parentType: string | null; childTypes: string[] }
): ProjectParam[] {
  const kids = new Set(opts.childTypes)
  return types.filter(t => {
    if (t.key === opts.current) return true
    if (!canBeUnder(t.key, opts.parentType)) return false
    // 底下有錯誤 → 自己一定要是任務；底下有大項目 → 自己一定要是大項目
    if (kids.has(BUG) && t.key !== 'TASK') return false
    if (kids.has(EPIC) && t.key !== EPIC) return false
    return true
  })
}
