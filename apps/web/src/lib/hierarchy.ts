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
export function canBeUnder(_type: string, _parentType: string | null): boolean {
  return true
}

export function typesAllowedUnder(
  types: ProjectParam[], _parentType: string | null
): ProjectParam[] {
  return types
}

export function typesAllowedFor(
  types: ProjectParam[],
  _opts: { current: string; parentType: string | null; childTypes: string[] }
): ProjectParam[] {
  return types
}
