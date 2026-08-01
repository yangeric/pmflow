/**
 * Fractional ranking：拖曳排序只 UPDATE 一列，不用重排整欄。
 *
 * 插在 A 與 B 之間 → (A+B)/2。插最前面 → first/2。插最後面 → last+1000。
 * 反覆對半分會讓浮點數精度用完，所以低於門檻時回報需要 rebalance。
 */
const GAP = 1000
const MIN_GAP = 1e-6

export function rankBetween(before: number | null, after: number | null): {
  rank: number; needsRebalance: boolean
} {
  if (before == null && after == null) return { rank: GAP, needsRebalance: false }
  if (before == null) return { rank: after! / 2, needsRebalance: Math.abs(after!) < MIN_GAP * 2 }
  if (after == null) return { rank: before + GAP, needsRebalance: false }
  const gap = after - before
  return { rank: before + gap / 2, needsRebalance: gap < MIN_GAP }
}

/** rebalance 用：把一串 id 重新配成 1000, 2000, 3000… */
export function evenRanks(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * GAP)
}
