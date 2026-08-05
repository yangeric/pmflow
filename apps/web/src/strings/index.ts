import { common } from './common'
import { nav } from './nav'
import { task } from './task'
import { project } from './project'
import { account } from './account'
import { inquiry } from './inquiry'
import { chart } from './chart'
import { calendar } from './calendar'
import { week } from './week'
import { settings } from './settings'

/**
 * 畫面上的文字全部集中在這裡，**不要寫死在元件裡**。
 *
 * 為什麼：文案是最常被改的東西 —— 「待驗收」要不要改叫「等驗收」、
 * 錯誤訊息要不要講得客氣一點、同一個概念在三個頁面用了三種說法。
 * 散在 JSX 裡的時候，改一句話要翻遍整個專案，而且一定會漏掉一個地方。
 * 集中之後，要對齊用詞只要讀這幾個檔；哪天要做多語系，這裡就是唯一的入口。
 *
 * **怎麼寫**
 * - 純文字直接放字串：`save: '儲存'`
 * - 需要帶值的放函式：`deleted: (name: string) => `已刪除 ${name}``
 *   —— 不要在元件裡拼字串，中文與英文的語序不一樣，拼起來的句子搬不動。
 * - 分檔照畫面的區塊，不照元件檔名：同一句話常常兩三個元件都在用。
 * - 共用的（儲存、取消、刪除、載入中…）一律放 common，不要每個區塊各寫一份。
 *
 * **不放這裡的東西**：後端回來的訊息（那是後端的文案）、資料本身
 * （專案名稱、狀態名稱那些是使用者自己打的）、還有 aria-label 以外的無障礙屬性值。
 */
export const T = {
  common,
  nav,
  task,
  project,
  account,
  inquiry,
  chart,
  calendar,
  week,
  settings,
}
