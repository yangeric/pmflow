/**
 * 排程引擎：依賴推算 + 關鍵路徑。
 *
 * 刻意在後端算，不靠前端甘特函式庫 ——
 * dhtmlx-gantt 的自動排程與關鍵路徑是 PRO 功能，我們自己算就繞開了，
 * 而且伺服器端算才能保證多人同時操作時看到同一份結果。
 */

export type LinkType = 'FS' | 'SS' | 'FF' | 'SF'

export interface SchedTask {
  id: string
  label: string
  startDate: string | null   // YYYY-MM-DD
  dueDate: string | null
  scheduleMode: 'AUTO' | 'MANUAL'
}

export interface SchedLink {
  sourceId: string
  targetId: string
  linkType: LinkType
  lagDays: number
}

export interface SchedResult {
  tasks: Record<string, { start: string | null; finish: string | null; totalFloat: number | null }>
  criticalPath: string[]
  conflicts: Array<{ taskId: string; label: string; reason: string }>
  cyclic: boolean
}

const DAY = 86_400_000
const toD = (s: string): number => Date.parse(s + 'T00:00:00Z')
const toS = (n: number): string => new Date(n).toISOString().slice(0, 10)

export function schedule(tasks: SchedTask[], links: SchedLink[]): SchedResult {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const out: SchedResult['tasks'] = {}
  const conflicts: SchedResult['conflicts'] = []

  // 工期先固定住：推算會平移任務，但不改變它要做幾天
  const duration = new Map<string, number>()
  for (const t of tasks) {
    const s = t.startDate ? toD(t.startDate) : null
    const f = t.dueDate ? toD(t.dueDate) : null
    duration.set(t.id, s != null && f != null ? Math.max(0, f - s) : 0)
    out[t.id] = { start: t.startDate, finish: t.dueDate, totalFloat: null }
  }

  // 拓撲排序（Kahn）。有環就直接回報，不做任何推算。
  const indeg = new Map(tasks.map(t => [t.id, 0]))
  const adj = new Map<string, SchedLink[]>()
  for (const l of links) {
    if (!byId.has(l.sourceId) || !byId.has(l.targetId)) continue
    adj.set(l.sourceId, [...(adj.get(l.sourceId) ?? []), l])
    indeg.set(l.targetId, (indeg.get(l.targetId) ?? 0) + 1)
  }
  const queue = tasks.filter(t => (indeg.get(t.id) ?? 0) === 0).map(t => t.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const l of adj.get(id) ?? []) {
      const d = (indeg.get(l.targetId) ?? 0) - 1
      indeg.set(l.targetId, d)
      if (d === 0) queue.push(l.targetId)
    }
  }
  if (order.length !== tasks.length) {
    return { tasks: out, criticalPath: [], conflicts, cyclic: true }
  }

  // ── 前向推算：把每個 AUTO 任務推到「所有前置條件都滿足」的最早時間 ──
  const inLinks = new Map<string, SchedLink[]>()
  for (const l of links) inLinks.set(l.targetId, [...(inLinks.get(l.targetId) ?? []), l])

  for (const id of order) {
    const t = byId.get(id)!
    const cur = out[id]
    const incoming = inLinks.get(id) ?? []
    if (!incoming.length) continue

    let minStart = cur.start != null ? toD(cur.start) : null
    let minFinish = cur.finish != null ? toD(cur.finish) : null
    const dur = duration.get(id) ?? 0

    for (const l of incoming) {
      const src = out[l.sourceId]
      const lag = l.lagDays * DAY
      const ss = src.start != null ? toD(src.start) : null
      const sf = src.finish != null ? toD(src.finish) : null
      let reqStart: number | null = null
      let reqFinish: number | null = null

      // 日期是「含頭含尾」的：08-01~08-05 佔 5 天。
      // 所以 FS 是「前者完成的隔天」才開始 —— 少加這個 +1，
      // 每條 FS 鏈都會多出一天浮時，關鍵路徑就抓不出來。
      switch (l.linkType) {
        case 'FS': if (sf != null) reqStart = sf + DAY + lag; break  // 完成的隔天開始
        case 'SS': if (ss != null) reqStart = ss + lag; break        // 同時起跑
        case 'FF': if (sf != null) reqFinish = sf + lag; break       // 同時收尾
        case 'SF': if (ss != null) reqFinish = ss + lag; break       // 前者開始後才能收尾
      }
      if (reqStart != null) minStart = minStart == null ? reqStart : Math.max(minStart, reqStart)
      if (reqFinish != null) minFinish = minFinish == null ? reqFinish : Math.max(minFinish, reqFinish)
    }

    // MANUAL 的任務日期是鎖死的，成為排程的固定錨點。
    // 違反約束時不強行改它，而是回報衝突讓人決定 —— OpenProject 的作法，
    // 讓使用者能局部逃脫約束求解器。
    if (t.scheduleMode === 'MANUAL') {
      const s = cur.start != null ? toD(cur.start) : null
      const f = cur.finish != null ? toD(cur.finish) : null
      if (minStart != null && s != null && s < minStart) {
        conflicts.push({
          taskId: id, label: t.label,
          reason: `人工鎖定的開始日 ${toS(s)} 早於依賴要求的 ${toS(minStart)}`,
        })
      }
      if (minFinish != null && f != null && f < minFinish) {
        conflicts.push({
          taskId: id, label: t.label,
          reason: `人工鎖定的結束日 ${toS(f)} 早於依賴要求的 ${toS(minFinish)}`,
        })
      }
      continue
    }

    if (minStart != null) {
      cur.start = toS(minStart)
      cur.finish = toS(minStart + dur)
    }
    if (minFinish != null) {
      const f = cur.finish != null ? toD(cur.finish) : minFinish
      if (f < minFinish) {
        cur.finish = toS(minFinish)
        cur.start = toS(minFinish - dur)
      }
    }
  }

  // ── 後向推算：求最晚可開始時間，total float = 0 者即為關鍵路徑 ──
  const projectEnd = Math.max(
    ...Object.values(out).map(v => (v.finish != null ? toD(v.finish) : -Infinity)),
    -Infinity
  )
  if (!isFinite(projectEnd)) {
    return { tasks: out, criticalPath: [], conflicts, cyclic: false }
  }

  const latestFinish = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const outgoing = adj.get(id) ?? []
    let lf = projectEnd
    for (const l of outgoing) {
      const tgt = out[l.targetId]
      const lag = l.lagDays * DAY
      const tgtLF = latestFinish.get(l.targetId) ?? projectEnd
      const tgtDur = duration.get(l.targetId) ?? 0
      const tgtLS = tgtLF - tgtDur
      let cand = projectEnd
      // 後向推算必須與前向用同一組慣例，否則浮時會恆偏一天
      switch (l.linkType) {
        case 'FS': cand = tgtLS - DAY - lag; break
        case 'SS': cand = tgtLS - lag + (duration.get(id) ?? 0); break
        case 'FF': cand = tgtLF - lag; break
        case 'SF': cand = tgtLF - lag + (duration.get(id) ?? 0); break
      }
      lf = Math.min(lf, cand)
      void tgt
    }
    latestFinish.set(id, lf)
    const ef = out[id].finish != null ? toD(out[id].finish!) : null
    out[id].totalFloat = ef != null ? Math.round((lf - ef) / DAY) : null
  }

  const criticalPath = order.filter(id => out[id].totalFloat === 0 && out[id].finish != null)
  return { tasks: out, criticalPath, conflicts, cyclic: false }
}
