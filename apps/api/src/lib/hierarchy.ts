import type { Db } from './db.js'
import { badRequest } from './errors.js'

/**
 * 任務種類決定它**可以掛在誰底下**（2026-08-05 定，見 AGENTS.md
 * 「任務種類的上下關係」）。
 *
 *  - **大項目（EPIC）一定在任務上面**：只能放最上層，或放在另一個大項目底下。
 *  - **錯誤（BUG）只能在任務下面**：上層一定要是任務，也不能放最上層。
 *  - **任務與里程碑不能站在最上層**：最上層只放得下大項目。
 *    掛在另一張任務底下（子任務）是可以的。
 *  - **專案自己新增的種類不受限制** —— 每個專案的種類清單是自己的
 *    （見 routes/parameters.ts），這條規則只認預設那四個 key。自訂種類
 *    不管當上層還是當下層都一律放行，不要順便也擋。
 *
 * **判斷只寫在這一支，四個入口（建立、改任務、拖曳、改種類連帶影響子任務）
 * 全部呼叫它。** 分四份寫一定會有一份漏掉。
 *
 * ## 既有資料可能已經違反
 *
 * 規則是後來才定的，示範資料裡就有「錯誤掛在大項目底下」。所以：
 *
 *  - **讀取一律照舊**，不合規的資料照樣讀得到、看得到，不藏也不報錯 ——
 *    藏起來只會讓人以為資料掉了。
 *  - **只在這次異動真的動到種類或上層時才檢查**。一張本來就不合法的任務
 *    被改標題、換負責人一樣要放行，否則那張任務會變成誰都動不了。
 *  - 子任務那一關比對的是「這次異動有沒有讓它變得更糟」：本來就不合法的
 *    子任務不會因為父任務改了種類而擋住整筆異動。
 */

const EPIC = 'EPIC'
const TASK = 'TASK'
const BUG = 'BUG'
const MILESTONE = 'MILESTONE'

/**
 * 錯誤訊息裡的稱呼。**畫面會直接顯示後端的訊息，所以不出現英文縮寫。**
 * 只有預設的四種需要 —— 自訂種類永遠不會走進違規的分支。
 */
const LABEL: Record<string, string> = {
  [EPIC]: '大項目',
  [TASK]: '任務',
  [BUG]: '問題',
  [MILESTONE]: '里程碑',
}

const label = (key: string): string => LABEL[key] ?? `「${key}」`

/** 這個 key 是不是預設那四種。不是的話這條規則完全不管它 */
const isBuiltin = (key: string | null): boolean =>
  key !== null && key in LABEL

interface Violation { title: string; detail: string }

/**
 * 「這個種類的任務掛在這個種類的上層底下」合不合法。合法回 null。
 *
 * `parentType === null` 代表放在最上層。上層是自訂種類時一律放行。
 */
function checkPlacement(type: string, parentType: string | null): Violation | null {
  if (type === EPIC) {
    if (parentType === null || parentType === EPIC) return null
    if (!isBuiltin(parentType)) return null
    return {
      title: `${label(EPIC)}不能放在${label(parentType)}底下`,
      detail: `${label(EPIC)}只能放在最上層，或放在另一個${label(EPIC)}底下。`,
    }
  }

  if (type === BUG) {
    if (parentType === TASK) return null
    if (parentType !== null && !isBuiltin(parentType)) return null
    if (parentType === null) {
      return {
        title: `${label(BUG)}一定要掛在一張${label(TASK)}底下`,
        detail: `${label(BUG)}不能自己放在最上層，`
          + `請先挑一張${label(TASK)}當它的上層。`,
      }
    }
    return {
      title: `${label(BUG)}不能放在${label(parentType)}底下`,
      detail: `${label(BUG)}的上層一定要是一張${label(TASK)}。`,
    }
  }

  /*
   * 任務與里程碑允許放在最上層 (parentType === null)，也允許掛在其他任務或大項目底下。
   */
  if (type === TASK || type === MILESTONE) {
    return null
  }

  // 專案自己新增的種類：不受限制
  return null
}

/** 上層是誰、它是什麼種類。找不到（不存在或已刪）就回 undefined，交給呼叫端原本的檢查處理 */
async function parentTypeOf(db: Db, parentId: string): Promise<string | undefined> {
  const [row] = await db<{ type: string }[]>`
    SELECT type FROM task WHERE id = ${parentId} AND deleted_at IS NULL`
  return row?.type
}

export interface HierarchyChange {
  /** 既有任務的 id。建立新任務時不用給 */
  taskId?: string
  /** 這次要變成的種類。**不改種類就不要帶** */
  nextType?: string
  /** 這次要換到的上層。**不改上層就不要帶**；帶 `{ id: null }` 代表搬到最上層 */
  nextParent?: { id: string | null }
}

/**
 * 建立、改任務、拖曳三條路都呼叫這一支。不合法就丟 400。
 *
 * 沒有動到種類也沒有動到上層時直接返回 —— 見檔頭「既有資料可能已經違反」。
 */
export async function assertTypeHierarchy(db: Db, change: HierarchyChange): Promise<void> {
  const typeChanged = change.nextType !== undefined
  const parentChanged = change.nextParent !== undefined
  if (!typeChanged && !parentChanged) return

  // 既有任務：沒帶到的那一邊維持現狀，要拿現在的值來湊出「異動之後的樣子」
  let currentType: string | null = null
  let currentParentId: string | null = null
  if (change.taskId) {
    const [row] = await db<{ type: string; parentId: string | null }[]>`
      SELECT type, parent_id AS "parentId" FROM task WHERE id = ${change.taskId}`
    if (!row) return                       // 找不到任務就不是這一關的事
    currentType = row.type
    currentParentId = row.parentId
  }

  // 建立時沒填種類，寫進資料庫的預設是 TASK（見 routes/tasks.ts 的 INSERT）
  const nextType = change.nextType ?? currentType ?? TASK
  const nextParentId = change.nextParent ? change.nextParent.id : currentParentId

  // ── ① 這張任務自己站得住腳嗎 ──
  let nextParentType: string | null = null
  if (nextParentId) {
    const t = await parentTypeOf(db, nextParentId)
    if (t === undefined) return            // 上層不存在，交給呼叫端原本的錯誤
    nextParentType = t
  }
  const own = checkPlacement(nextType, nextParentType)
  if (own) throw badRequest(own.title, own.detail)

  // ── ② 改種類會不會害到既有的子任務 ──
  // 例：一張任務底下掛著問題，把它改成大項目 → 那些問題就變成「掛在大項目底下」。
  // 只比對「本來合法、改完變不合法」的子任務；本來就不合法的不算這次異動的帳。
  if (!change.taskId || currentType === null || nextType === currentType) return

  const children = await db<{ type: string; ref: string }[]>`
    SELECT t.type, p.key || '-' || t.number AS ref
    FROM task t JOIN project p ON p.id = t.project_id
    WHERE t.parent_id = ${change.taskId} AND t.deleted_at IS NULL
    ORDER BY t.number`

  const broken = children.filter(c =>
    !checkPlacement(c.type, currentType) && checkPlacement(c.type, nextType))
  if (!broken.length) return

  const kinds = [...new Set(broken.map(c => label(c.type)))].join('、')
  const refs = broken.map(c => c.ref).join('、')
  throw badRequest(
    `這張任務底下還有${kinds}，不能改成${label(nextType)}`,
    `改成${label(nextType)}之後，底下的 ${refs} 就會變成掛在${label(nextType)}底下，`
    + `不符合種類的上下關係。請先把它們搬到別的上層，再回來改這張任務的種類。`)
}

/**
 * 把某一種任務整批改成另一種之後，會有幾張放錯位置。
 *
 * 只有「刪掉一種任務種類、把用它的任務整批搬到另一種」那條路
 * （`routes/parameters.ts` 的 `moveTo`）需要它。那條路一次改幾十張，
 * 建立與編輯時逐張擋的規則在那裡完全繞得過去。
 *
 * 兩邊都要算：這些任務**自己**會不會放錯（看它們各自的上層），
 * 以及它們**底下掛的東西**會不會因此放錯（例如整批變成大項目，
 * 原本掛在它們底下的問題就沒有任務當上層了）。
 *
 * 回傳張數而不是丟例外 —— 呼叫端要把數字寫進訊息裡，
 * 只說「不行」的話他得自己一張一張猜是哪幾張卡住。
 */
export async function countIllegalAfterRetype(
  db: Db, projectId: string, fromKey: string, toKey: string
): Promise<number> {
  // 自訂種類不受規則管，改成它不會產生任何違規
  if (!isBuiltin(toKey)) return 0

  const rows = await db<{ id: string; parentType: string | null }[]>`
    SELECT t.id, parent.type AS "parentType"
    FROM task t
    LEFT JOIN task parent ON parent.id = t.parent_id AND parent.deleted_at IS NULL
    WHERE t.project_id = ${projectId} AND t.type = ${fromKey} AND t.deleted_at IS NULL`

  const offenders = new Set<string>()
  for (const r of rows) {
    if (checkPlacement(toKey, r.parentType)) offenders.add(r.id)
  }

  // 底下掛著的東西：本來合法、改完變不合法的才算這次的帳
  const kids = await db<{ id: string; type: string; parentId: string }[]>`
    SELECT c.id, c.type, c.parent_id AS "parentId"
    FROM task c
    JOIN task p ON p.id = c.parent_id AND p.deleted_at IS NULL
    WHERE c.project_id = ${projectId} AND p.type = ${fromKey} AND c.deleted_at IS NULL`
  for (const k of kids) {
    if (!checkPlacement(k.type, fromKey) && checkPlacement(k.type, toKey)) offenders.add(k.id)
  }

  return offenders.size
}
