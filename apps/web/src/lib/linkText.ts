import type { LinkType } from './api'
import { T } from '../strings'

/**
 * 關聯類型的中文說法。
 *
 * 資料庫存的仍是 FS / SS / FF / SF 這些代碼（migration 與 API 契約不動），
 * 這裡只負責「講人話」—— 使用者不該需要知道那四個縮寫是什麼意思。
 *
 *   等待任務【完成】，才能【開始】   ← 前半講來源那一端，後半講自己這一端
 *
 * 字本身放在 strings/chart.ts，這裡只是取個好記的名字給元件用 ——
 * 任務詳情、通知、關聯圖三個地方講的是同一句話，過去各留了一份副本，
 * 改了其中一份另外兩份就對不上。
 */
export const LINK_LABEL: Record<LinkType, string> = T.chart.graph.linkLabel

/** 清單與線上用的短標籤，空間有限時用 */
export const LINK_CHIP: Record<LinkType, string> = T.chart.graph.linkChip

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
  return T.chart.graph.sentence[type][direction](ref)
}
