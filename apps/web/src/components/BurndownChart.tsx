import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { BurndownPoint, BurndownResult, DashboardMetric } from '../lib/api'
import { Button, Empty, cx } from './ui'
import { shortDate } from '../lib/date'
import { T } from '../strings'

/**
 * 燃盡圖 —— 手刻 inline SVG，不引進圖表套件。
 *
 * 為什麼自己刻：recharts / d3 / visx 進來就是幾百 KB 的 bundle 加上一串
 * 授權要重新掃的相依，而這裡要畫的只有三條折線與一組格線。畫線本身
 * 沒有難處，難的是「別畫錯」—— 所以規矩都寫在下面：
 *
 * 1. **SVG 用 1:1 的座標，不做非等比縮放**。寬度靠 ResizeObserver 量出來
 *    再重畫，不用 `preserveAspectRatio="none"` 那招 —— 那會把座標軸上的字
 *    一起拉扁，區間越長字越醜。
 * 2. **實際線畫到今天為止就停**：`isFuture` 的點 remaining / total 是 null，
 *    未來沒有實際值，硬把它接到 0 會讓人以為專案已經燒完了。理想線是
 *    參考線，一路畫到底。
 * 3. **理想線是灰色虛線**。它不是資料，是「照計畫應該剩下多少」，
 *    跟實際線同樣鮮豔的話兩條線會被讀成同一種東西。
 * 4. **字一律用 slate 系的文字色**，不拿線的顏色去寫字（色盲的人只剩字可讀）。
 *    線的身分由圖例與線末端的色點負責。
 */

/**
 * 三條線的顏色。這兩個藍已經用色盲模擬器驗過與琥珀色分得開，不要自己換 ——
 * 深色底下要亮一階（blue-600 沉進 slate-900 裡），琥珀兩邊同一個值就夠。
 * 寫成 Tailwind 的 class 而不是 style，深色切換才不用在 JS 裡讀主題。
 */
const LINE = {
  remaining: 'stroke-[#2563eb] dark:stroke-[#3b82f6]',
  total: 'stroke-[#d97706] dark:stroke-[#d97706]',
  ideal: 'stroke-slate-400 dark:stroke-slate-400',
}
const DOT = {
  remaining: 'fill-[#2563eb] dark:fill-[#3b82f6]',
  total: 'fill-[#d97706] dark:fill-[#d97706]',
  ideal: 'fill-slate-400 dark:fill-slate-400',
}

const PAD = { top: 14, right: 76, bottom: 34, left: 54 }
const H = 288
const MIN_W = 360

type Series = 'remaining' | 'total' | 'ideal'

export default function BurndownChart({ data, metric }: {
  data: BurndownResult
  metric: DashboardMetric
}) {
  const [asTable, setAsTable] = useState(false)
  const [box, width] = useElementWidth<HTMLDivElement>()

  const pts = data.points

  /** 有幾種不同的實際值 —— 只有一種代表這條線從頭到尾沒動過 */
  const flat = useMemo(() => {
    const seen = new Set<number>()
    for (const p of pts) if (p.remaining !== null) seen.add(p.remaining)
    return seen.size <= 1
  }, [pts])

  return (
    <section className="rounded-lg bg-white p-4 ring-1 ring-slate-200
                        dark:bg-slate-900 dark:ring-slate-700">

      {/* ── 標題列 ── */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {T.dashboard.burndown.title}
        </h3>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {T.dashboard.burndown.subtitle}
        </span>
        <Button className="ml-auto" onClick={() => setAsTable(v => !v)}>
          {asTable ? T.dashboard.tableView.hide : T.dashboard.tableView.show}
        </Button>
      </div>

      {pts.length === 0 || data.taskCount === 0 ? (
        <Empty>
          <div className="font-medium text-slate-500 dark:text-slate-400">
            {pts.length === 0
              ? T.dashboard.burndown.noHistoryTitle
              : T.dashboard.burndown.emptyTitle}
          </div>
          <div className="mt-1">
            {pts.length === 0
              ? T.dashboard.burndown.noHistoryHint
              : T.dashboard.burndown.emptyHint}
          </div>
        </Empty>
      ) : (
        <>
          <StatRow data={data} metric={metric} />

          {asTable ? (
            <BurndownTable points={pts} metric={metric} />
          ) : (
            <>
              <Legend />
              <div ref={box} className="relative mt-1">
                <Plot points={pts} metric={metric} width={Math.max(MIN_W, width)} />
              </div>
            </>
          )}

          {/*
            * 這條線是回推出來的，哪幾張是估的一定要講 —— 誠實揭露，
            * 不做成可關掉的提示：關掉之後看的人就會拿估出來的數字去跟人吵架。
            */}
          {data.estimatedCount > 0 && (
            <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {T.dashboard.burndown.estimatedNote(data.estimatedCount)}
            </p>
          )}

          {/* 有點但整條線沒動過：圖照畫（總量與理想線還是有意義），但要說明為什麼是平的 */}
          {flat && (
            <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              <span className="font-medium">{T.dashboard.burndown.noHistoryTitle}</span>
              {' '}
              {T.dashboard.burndown.noHistoryHint}
            </p>
          )}
        </>
      )}
    </section>
  )
}

// ── 圖上方的三個數字 ────────────────────────────────────
function StatRow({ data, metric }: { data: BurndownResult; metric: DashboardMetric }) {
  const S = T.dashboard.burndown.stat
  const remaining = data.todayRemaining
  const ideal = data.todayIdeal

  /**
   * 落後與超前是兩句不同的話，不共用一句加正負號 ——
   * 「落後 -3 張」沒有人看得懂。都做完了就只講做完了，那時候差幾張沒有意義。
   */
  let diffText: string = S.onTrack
  let tone = 'text-slate-500 dark:text-slate-400'
  if (remaining !== null && remaining <= 0) {
    diffText = S.done
    tone = 'text-emerald-600 dark:text-emerald-400'
  } else if (remaining !== null && ideal !== null) {
    const d = round(remaining - ideal, metric)
    if (d > 0) {
      diffText = S.behind(fmt(d, metric))
      tone = 'text-red-600 dark:text-red-400'
    } else if (d < 0) {
      diffText = S.ahead(fmt(-d, metric))
      tone = 'text-emerald-600 dark:text-emerald-400'
    }
  }

  return (
    <div className="mb-3 flex flex-wrap items-end gap-x-8 gap-y-2">
      <Stat label={S.remaining} value={remaining === null ? '—' : fmt(remaining, metric)} />
      <Stat label={S.ideal} value={ideal === null ? '—' : fmt(ideal, metric)} />
      {/* 第三個不另外給標題 —— 「落後 3 張」本身就是一句話，再加一行標題只是重複 */}
      <div className={cx('self-end text-lg font-semibold tabular-nums', tone)}>{diffText}</div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
        {value}
      </div>
    </div>
  )
}

// ── 圖例 ────────────────────────────────────────────────
function Legend() {
  const L = T.dashboard.burndown.legend
  const items: Array<{ k: Series; text: string; dashed: boolean }> = [
    { k: 'remaining', text: L.remaining, dashed: false },
    { k: 'total', text: L.total, dashed: false },
    { k: 'ideal', text: L.ideal, dashed: true },
  ]
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map(it => (
        <li key={it.k} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <svg width={20} height={8} aria-hidden className="shrink-0">
            <line x1={0} y1={4} x2={20} y2={4} strokeWidth={2}
                  strokeDasharray={it.dashed ? '4 3' : undefined}
                  className={LINE[it.k]} />
          </svg>
          {it.text}
        </li>
      ))}
    </ul>
  )
}

// ── 繪圖區 ──────────────────────────────────────────────
function Plot({ points, metric, width }: {
  points: BurndownPoint[]
  metric: DashboardMetric
  width: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const clipId = svgId(useId(), 'clip')

  const n = points.length
  const plotW = Math.max(40, width - PAD.left - PAD.right)
  const plotH = H - PAD.top - PAD.bottom

  const scale = useMemo(() => {
    let max = 0
    for (const p of points) {
      if (p.remaining !== null) max = Math.max(max, p.remaining)
      if (p.total !== null) max = Math.max(max, p.total)
      max = Math.max(max, p.ideal)
    }
    return niceScale(max)
  }, [points])

  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - (v / scale.max) * plotH

  const get: Record<Series, (p: BurndownPoint) => number | null> = {
    remaining: p => p.remaining,
    total: p => p.total,
    ideal: p => p.ideal,
  }

  /** x 軸的日期標籤：一格至少留 52px，區間長就跳著標，不然數字會疊成一團 */
  const labelStep = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 52))))
  const todayIndex = points.findIndex(p => p.isToday)

  /** 線末端直接標數字。兩條實際線常常停在同一個 x，y 太近就上下推開 */
  const endLabels = useMemo(() => {
    const out: Array<{ k: Series; x: number; y: number; text: string }> = []
    for (const k of ['remaining', 'total', 'ideal'] as Series[]) {
      for (let i = n - 1; i >= 0; i--) {
        const v = get[k](points[i])
        if (v === null) continue
        out.push({ k, x: x(i), y: y(v), text: fmt(v, metric) })
        break
      }
    }
    out.sort((a, b) => a.y - b.y)
    for (let i = 1; i < out.length; i++) {
      if (out[i].y - out[i - 1].y < 13) out[i].y = out[i - 1].y + 13
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, metric, plotW, scale.max])

  const onMove = (e: MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || n === 0) return
    const px = e.clientX - rect.left
    const i = n <= 1 ? 0 : Math.round(((px - PAD.left) / plotW) * (n - 1))
    setHover(Math.min(n - 1, Math.max(0, i)))
  }

  const hp = hover === null ? null : points[hover]

  return (
    <>
      <svg
        ref={svgRef}
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={T.dashboard.burndown.title}
        className="block select-none"
      >
        <defs>
          {/* 線超出繪圖區時剪掉，不要壓到座標軸的字 */}
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top - 4} width={plotW} height={plotH + 8} />
          </clipPath>
        </defs>

        {/* ── 格線與 y 軸刻度。細、淺、不搶戲 ── */}
        {scale.ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} y1={y(t)} x2={PAD.left + plotW} y2={y(t)}
                  strokeWidth={1} className="stroke-slate-200 dark:stroke-slate-700" />
            <text x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end"
                  className="fill-slate-400 text-[10px] tabular-nums dark:fill-slate-400">
              {tickText(t)}
            </text>
          </g>
        ))}

        {/* y 軸標題，直立放在最左邊 */}
        <text
          transform={`translate(13 ${PAD.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          className="fill-slate-500 text-[11px] dark:fill-slate-400"
        >
          {metric === 'hours'
            ? T.dashboard.burndown.axis.remainingHours
            : T.dashboard.burndown.axis.remainingCount}
        </text>

        {/* ── x 軸 ── */}
        <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH}
              strokeWidth={1} className="stroke-slate-300 dark:stroke-slate-600" />
        {points.map((p, i) => (
          i % labelStep === 0 || i === n - 1 ? (
            <text key={p.date} x={x(i)} y={H - 14} textAnchor="middle"
                  className={cx(
                    'text-[10px] tabular-nums',
                    p.isWeekend
                      ? 'fill-slate-300 dark:fill-slate-500'
                      : 'fill-slate-400 dark:fill-slate-400'
                  )}>
              {shortDate(p.date)}
            </text>
          ) : null
        ))}

        {/* 今天：一條淡淡的直線，跟游標的準星分得開（那條比較深） */}
        {todayIndex >= 0 && (
          <line x1={x(todayIndex)} y1={PAD.top} x2={x(todayIndex)} y2={PAD.top + plotH}
                strokeWidth={1} strokeDasharray="2 3"
                className="stroke-slate-300 dark:stroke-slate-600" />
        )}

        <g clipPath={`url(#${clipId})`}>
          {/* 理想線先畫，實際線壓在上面 —— 參考線不該蓋住資料 */}
          <path d={linePath(points, get.ideal, x, y)} fill="none" strokeWidth={1.5}
                strokeDasharray="5 4" strokeLinecap="round" className={LINE.ideal} />
          <path d={linePath(points, get.total, x, y)} fill="none" strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" className={LINE.total} />
          <path d={linePath(points, get.remaining, x, y)} fill="none" strokeWidth={2.25}
                strokeLinejoin="round" strokeLinecap="round" className={LINE.remaining} />
        </g>

        {/* 線末端直接標數字：色點負責身分，字一律是 slate */}
        {endLabels.map(l => (
          <g key={l.k}>
            <circle cx={l.x} cy={l.y} r={3} className={DOT[l.k]} />
            <text x={l.x + 7} y={l.y + 3.5}
                  className="fill-slate-500 text-[10px] tabular-nums dark:fill-slate-300">
              {l.text}
            </text>
          </g>
        ))}

        {/* ── 游標的十字準星 ── */}
        {hover !== null && hp && (
          <g pointerEvents="none">
            <line x1={x(hover)} y1={PAD.top} x2={x(hover)} y2={PAD.top + plotH}
                  strokeWidth={1} className="stroke-slate-400 dark:stroke-slate-500" />
            {(['ideal', 'total', 'remaining'] as Series[]).map(k => {
              const v = get[k](hp)
              return v === null ? null : (
                <circle key={k} cx={x(hover)} cy={y(v)} r={3.5} strokeWidth={1.5}
                        className={cx(DOT[k], 'stroke-white dark:stroke-slate-900')} />
              )
            })}
          </g>
        )}

        {/*
          * 滑鼠事件只掛這一塊透明的 rect，用 x 座標反推最近的那一天。
          * 每個點各掛一個 handler 的話，點跟點之間的空隙就是死區，
          * 而且區間一長就是好幾百個監聽器。
          */}
        <rect
          x={PAD.left} y={PAD.top} width={plotW} height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hover !== null && hp && (
        <Tooltip point={hp} metric={metric} left={x(hover)} width={width} />
      )}
    </>
  )
}

// ── 滑過去顯示的那一小塊 ────────────────────────────────
function Tooltip({ point, metric, left, width }: {
  point: BurndownPoint
  metric: DashboardMetric
  left: number
  width: number
}) {
  const TT = T.dashboard.burndown.tooltip
  // 靠近右邊時翻到游標左側，不然會被卡片邊緣切掉
  const flip = left > width - 170
  const rows: Array<{ k: Series | 'done'; label: string; value: string }> = [
    {
      k: 'remaining', label: TT.remaining,
      value: point.remaining === null ? TT.future : fmt(point.remaining, metric),
    },
    {
      k: 'total', label: TT.total,
      value: point.total === null ? TT.future : fmt(point.total, metric),
    },
    { k: 'ideal', label: TT.ideal, value: fmt(point.ideal, metric) },
    {
      k: 'done', label: TT.done,
      value: point.done === null ? TT.future : fmt(point.done, metric),
    },
  ]
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 min-w-[9.5rem] rounded-md bg-white p-2
                 text-xs shadow-lg ring-1 ring-slate-200
                 dark:bg-slate-800 dark:ring-slate-700"
      style={{ left, transform: flip ? 'translateX(-100%) translateX(-12px)' : 'translateX(12px)' }}
    >
      <div className="mb-1 font-medium tabular-nums text-slate-700 dark:text-slate-200">
        {point.date}
      </div>
      {rows.map(r => (
        <div key={r.k} className="flex items-center gap-2 leading-5">
          {r.k === 'done'
            ? <span className="h-1.5 w-1.5 shrink-0" />
            : <svg width={6} height={6} aria-hidden className="shrink-0">
                <circle cx={3} cy={3} r={3} className={DOT[r.k as Series]} />
              </svg>}
          <span className="text-slate-500 dark:text-slate-400">{r.label}</span>
          <span className="ml-auto tabular-nums text-slate-700 dark:text-slate-200">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── 表格版。色盲與螢幕閱讀器靠這個，不是備案 ────────────
function BurndownTable({ points, metric }: { points: BurndownPoint[]; metric: DashboardMetric }) {
  const L = T.dashboard.burndown.legend
  const TT = T.dashboard.burndown.tooltip
  const th = 'px-3 py-1.5 text-left font-medium'
  const td = 'px-3 py-1.5 tabular-nums'
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption className="sr-only">{T.dashboard.burndown.title}</caption>
        <thead>
          <tr className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <th scope="col" className={th}>{T.dashboard.tableView.date}</th>
            <th scope="col" className={cx(th, 'text-right')}>{L.remaining}</th>
            <th scope="col" className={cx(th, 'text-right')}>{L.total}</th>
            <th scope="col" className={cx(th, 'text-right')}>{L.ideal}</th>
            <th scope="col" className={cx(th, 'text-right')}>{TT.done}</th>
          </tr>
        </thead>
        <tbody>
          {points.map(p => (
            <tr key={p.date} className="border-t border-slate-100 dark:border-slate-800">
              <th scope="row"
                  className={cx(td, 'text-left font-normal',
                    p.isToday
                      ? 'font-semibold text-blue-700 dark:text-blue-300'
                      : p.isWeekend
                        ? 'text-slate-400 dark:text-slate-400'
                        : 'text-slate-700 dark:text-slate-300')}>
                {p.date}
              </th>
              <td className={cx(td, 'text-right text-slate-700 dark:text-slate-200')}>
                {p.remaining === null ? TT.future : fmt(p.remaining, metric)}
              </td>
              <td className={cx(td, 'text-right text-slate-700 dark:text-slate-200')}>
                {p.total === null ? TT.future : fmt(p.total, metric)}
              </td>
              <td className={cx(td, 'text-right text-slate-500 dark:text-slate-400')}>
                {fmt(p.ideal, metric)}
              </td>
              <td className={cx(td, 'text-right text-slate-700 dark:text-slate-200')}>
                {p.done === null ? TT.future : fmt(p.done, metric)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── 小工具 ──────────────────────────────────────────────

/**
 * 折線的路徑。**遇到 null 就斷開**（下一段重新 M）——
 * 未來的日子沒有實際值，把它接起來等於憑空畫一條沒發生過的線。
 */
function linePath(
  points: BurndownPoint[],
  get: (p: BurndownPoint) => number | null,
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = ''
  let open = false
  points.forEach((p, i) => {
    const v = get(p)
    if (v === null) { open = false; return }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)} `
    open = true
  })
  return d.trim()
}

/** 好看的刻度：上緣取整到 1 / 2 / 2.5 / 5 的倍數，最多五條線 */
function niceScale(max: number): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] }
  const raw = max / 4
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = ([1, 2, 2.5, 5, 10].find(m => m * mag >= raw) ?? 10) * mag
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { max: top, ticks }
}

const tickText = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))

/** 工時留一位小數就夠，張數一律整數 —— 「2.7 張任務」不是人話 */
const round = (v: number, metric: DashboardMetric) =>
  metric === 'hours' ? Math.round(v * 10) / 10 : Math.round(v)

const fmt = (v: number, metric: DashboardMetric) =>
  metric === 'hours'
    ? T.dashboard.unit.hours(round(v, metric))
    : T.dashboard.unit.count(round(v, metric))

/**
 * 量出容器現在多寬。
 *
 * 用 ResizeObserver 重畫，不用 `preserveAspectRatio="none"` 去拉伸 ——
 * 拉伸會連字一起變形，而座標軸上的字正是這張圖最需要讀得清楚的東西。
 */
function useElementWidth<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  const [w, setW] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const cw = entries[0]?.contentRect.width ?? 0
      if (cw > 0) setW(Math.round(cw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * useId 產出來的字含有 `:` / `«` 之類的字元，直接塞進 `url(#...)` 各家瀏覽器
 * 解讀不一。洗成只剩英數與底線再用，一張頁面上多張圖也不會撞號。
 */
function svgId(raw: string, suffix: string): string {
  return `pmflow-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}-${suffix}`
}
