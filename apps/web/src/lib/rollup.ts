import type { Task } from './api'

/**
 * 父任務（大項目）的數字要由子任務彙總，不能直接顯示資料庫存的值。
 *
 * 規格 §4.2：父任務完成率 = 子任務加權平均（權重 = 估時，沒填估時就等權），
 * 起日 = 子任務最早起日，迄日 = 子任務最晚迄日。
 *
 * 不這樣做的話畫面會自相矛盾：大項目寫 55%，底下三個子項目卻是 60% / 100% / 40%，
 * 看的人會不知道該信哪一個。
 *
 * 只有「有子任務」的節點會被彙總；葉節點沿用自己的值。
 */
export interface Rolled {
  progress: number
  startDate: string | null
  dueDate: string | null
  /** 有子任務＝這幾個數字是算出來的，不是使用者填的 */
  derived: boolean
  doneCount: number
  totalCount: number
}

export function rollup(tasks: Task[]): Map<string, Rolled> {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const children = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.parentId || !byId.has(t.parentId)) continue
    const a = children.get(t.parentId) ?? []
    a.push(t)
    children.set(t.parentId, a)
  }

  const out = new Map<string, Rolled>()
  const visiting = new Set<string>()

  function compute(id: string): Rolled {
    const cached = out.get(id)
    if (cached) return cached

    const self = byId.get(id)!
    const kids = children.get(id) ?? []

    // 資料若有環（理論上後端擋掉了）就當葉節點，別讓畫面整個爆掉
    if (!kids.length || visiting.has(id)) {
      const leaf: Rolled = {
        progress: self.progress,
        startDate: self.startDate,
        dueDate: self.dueDate,
        derived: false,
        doneCount: self.progress >= 100 ? 1 : 0,
        totalCount: 1,
      }
      out.set(id, leaf)
      return leaf
    }

    visiting.add(id)
    const rolled = kids.map(k => ({ kid: k, r: compute(k.id) }))
    visiting.delete(id)

    // 權重用估時；全部沒填就退回等權，避免除以零
    const weights = rolled.map(({ kid }) => {
      const h = Number(kid.estimateHours ?? 0)
      return Number.isFinite(h) && h > 0 ? h : 0
    })
    const sumW = weights.reduce((a, b) => a + b, 0)
    const useEqual = sumW <= 0

    let progress = 0
    rolled.forEach(({ r }, i) => {
      const w = useEqual ? 1 / rolled.length : weights[i] / sumW
      progress += r.progress * w
    })

    const starts = rolled.map(({ r }) => r.startDate).filter(Boolean) as string[]
    const dues = rolled.map(({ r }) => r.dueDate).filter(Boolean) as string[]

    const res: Rolled = {
      progress: Math.round(progress),
      startDate: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : self.startDate,
      dueDate: dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : self.dueDate,
      derived: true,
      doneCount: rolled.reduce((n, { r }) => n + r.doneCount, 0),
      totalCount: rolled.reduce((n, { r }) => n + r.totalCount, 0),
    }
    out.set(id, res)
    return res
  }

  for (const t of tasks) compute(t.id)
  return out
}

/** 今天（本地時區）的 YYYY-MM-DD，用來判斷是否真的逾期 */
export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 任務本身是否逾期＝有結束日、已過期、且尚未完成。
 * 注意這跟「單位逾期未回」（inquiryState）是兩回事，不要混用同一個紅色。
 */
export function isTaskOverdue(dueDate: string | null, progress: number): boolean {
  if (!dueDate || progress >= 100) return false
  return dueDate.slice(0, 10) < today()
}
