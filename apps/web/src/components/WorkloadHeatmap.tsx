import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DashboardMetric, WorkloadCell, WorkloadResult, WorkloadRow } from '../lib/api'
import { Button, Empty, cx } from './ui'
import { parseYmd, shortDate, WEEKDAY_LABELS } from '../lib/date'
import { T } from '../strings'

/**
 * 負載熱圖 —— 一列一個人、一欄一天，手刻 inline SVG。
 *
 * 三件事是這張圖存在的理由，畫的時候不能被「好看」蓋掉：
 *
 * 1. **超過負荷的格子不能只靠顏色**。紅色對紅綠色盲來說跟深藍分不開，
 *    所以超載的格子除了換色，右上角一定再壓一個小三角形。
 * 2. **請假那天還壓著事情的格子最重要**。請假用斜線紋理（不是換顏色）——
 *    紋理疊得上去，量的深淺才不會被「請假」這件事洗掉。
 * 3. **「沒有指定負責人」那一列照樣要畫**。那些事情如果不畫出來，
 *    就會整批消失在圖外，而那正是最容易漏掉的一堆事。
 *
 * 色階是**單一色相由淺到深**（藍），不是彩虹 —— 量是有大小順序的東西，
 * 換色相只會讓人去猜「綠比黃多還是少」。0 的格子用底色，不進色階。
 *
 * 座標一律是 1:1 的像素，不用百分比縮放 —— 縮放會把人名與日期一起拉扁。
 * 格子的寬度依容器算（見 CELL_MAX），窄到底還放不下才左右捲。
 */

const NAME_W = 150
/**
 * 格子的寬度會依容器縮，不是寫死的。
 *
 * 寫死 26px 的話，四週的圖就有 1034px 寬，一般視窗放不下 ——
 * 而被擠出畫面的正好是最右邊的「合計」與「最高一天」。
 * 那兩欄是整張圖的結論，不能是「捲過去才看得到」的東西。
 * 窄到 14px 還是放不下才讓它左右捲（八週＋窄視窗就會這樣）。
 */
const CELL_MAX = 26
const CELL_MIN = 14
const ROW_H = 26
const HEAD_H = 50
const SUM_W = 78
const PEAK_W = 78
const GAP = 2          // 格子之間留的縫，兩格才不會黏成一條

/**
 * 色階。淺色 blue-100 → blue-500，深色 blue-950 → blue-400。
 * 深色不是把淺色反過來用，是照 index.css 那張表另外挑一組 ——
 * 同一階在 slate-900 上的可讀性跟在白底上不一樣。
 * 寫成完整的 class 字串，Tailwind 才掃得到（拼出來的 class 不會被產生）。
 */
const RAMP = [
  'fill-slate-100 dark:fill-slate-800',      // 0：沒有事情
  'fill-blue-100 dark:fill-blue-950',
  'fill-blue-200 dark:fill-blue-900',
  'fill-blue-300 dark:fill-blue-800',
  'fill-blue-400 dark:fill-blue-600',
  'fill-blue-500 dark:fill-blue-400',
]
/** 週末那一欄的空格子再淡一階，一眼看得出哪兩欄是假日 */
const EMPTY_WEEKEND = 'fill-slate-50 dark:fill-slate-900'
/** 超過負荷：狀態色，跟色階不共用；另外還有右上角那個三角形 */
const OVER = 'fill-red-500 dark:fill-red-500'

export default function WorkloadHeatmap({ data, metric }: {
  data: WorkloadResult
  metric: DashboardMetric
}) {
  const [asTable, setAsTable] = useState(false)
  const uid = useId()

  const days = data.days
  const rows = data.rows
  const empty = days.length === 0 || rows.length === 0

  return (
    <section className="rounded-lg bg-white p-4 ring-1 ring-slate-200
                        dark:bg-slate-900 dark:ring-slate-700">

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {T.dashboard.workload.title}
        </h3>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {T.dashboard.workload.subtitle}
        </span>
        <Button className="ml-auto" onClick={() => setAsTable(v => !v)}>
          {asTable ? T.dashboard.tableView.hide : T.dashboard.tableView.show}
        </Button>
      </div>

      {empty ? (
        <Empty>
          <div className="font-medium text-slate-500 dark:text-slate-400">
            {T.dashboard.workload.emptyTitle}
          </div>
          <div className="mt-1">{T.dashboard.workload.emptyHint}</div>
        </Empty>
      ) : (
        <>
          <Legend hatchId={svgId(uid, 'legend-hatch')} />
          {asTable
            ? <WorkloadTable data={data} metric={metric} />
            : <Grid data={data} metric={metric} hatchId={svgId(uid, 'hatch')} />}

          <div className="mt-3 space-y-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            <p>{T.dashboard.workload.capacity(fmt(data.capacity, metric))}</p>
            <p>{T.dashboard.workload.spreadNote}</p>
          </div>
        </>
      )}
    </section>
  )
}

// ── 圖例 ────────────────────────────────────────────────
function Legend({ hatchId }: { hatchId: string }) {
  const L = T.dashboard.workload.legend
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1
                    text-xs text-slate-600 dark:text-slate-300">
      <span className="text-slate-500 dark:text-slate-400">{L.title}</span>
      <Swatch text={L.none}><rect width={14} height={14} rx={2} className={RAMP[0]} /></Swatch>
      <Swatch text={L.light}><rect width={14} height={14} rx={2} className={RAMP[2]} /></Swatch>
      <Swatch text={L.heavy}><rect width={14} height={14} rx={2} className={RAMP[5]} /></Swatch>
      <Swatch text={L.over}>
        <rect width={14} height={14} rx={2} className={OVER} />
        <path d="M14 0 L14 6 L8 0 Z" className="fill-white dark:fill-slate-900" />
      </Swatch>
      <Swatch text={L.leave} hatchId={hatchId}>
        <rect width={14} height={14} rx={2} className={RAMP[0]} />
        <rect width={14} height={14} rx={2} fill={`url(#${hatchId})`} />
      </Swatch>
    </div>
  )
}

function Swatch({ text, hatchId, children }: {
  text: string
  hatchId?: string
  children: ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width={14} height={14} aria-hidden className="shrink-0">
        {hatchId && <defs><LeaveHatch id={hatchId} /></defs>}
        {children}
      </svg>
      {text}
    </span>
  )
}

/**
 * 請假的斜線紋理。用紋理不用顏色 —— 顏色的位置已經被「量」佔走了，
 * 再拿一個顏色來講請假，兩件事就會互相蓋掉。
 * 線的顏色靠 class 跟著深色模式走（pattern 裡的 currentColor 各家瀏覽器解讀不一）。
 */
function LeaveHatch({ id }: { id: string }) {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      {/* 線畫在格子正中間，不畫在邊上 —— 畫在 x=0 的話有一半的筆寬落在
          圖樣外面，接不回來，斜線看起來會比設定的細一半 */}
      <line x1={3} y1={0} x2={3} y2={6} strokeWidth={2.5} strokeOpacity={0.55}
            className="stroke-slate-600 dark:stroke-slate-200" />
    </pattern>
  )
}

// ── 格子 ────────────────────────────────────────────────
function Grid({ data, metric, hatchId }: {
  data: WorkloadResult
  metric: DashboardMetric
  hatchId: string
}) {
  const [hover, setHover] = useState<{ r: number; i: number } | null>(null)
  const clipId = svgId(useId(), 'name-clip')

  const { days, rows, capacity, max } = data

  /*
   * 量容器有多寬，再決定一格幾 px。量不到（第一次算、或跑在測試環境）
   * 就先用最大值畫，量到之後再縮 —— 一開始畫太小的話，寬螢幕會閃一下。
   */
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(0)
  /** 橫捲了多少。提示框在捲動容器外面，位置要自己扣掉這一段 */
  const [scrollLeft, setScrollLeft] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setBoxW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cell = useMemo(() => {
    if (boxW === 0 || days.length === 0) return CELL_MAX
    const forGrid = boxW - NAME_W - SUM_W - PEAK_W
    return Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(forGrid / days.length)))
  }, [boxW, days.length])

  const gridW = days.length * cell
  const svgW = NAME_W + gridW + SUM_W + PEAK_W
  const svgH = HEAD_H + rows.length * ROW_H + 2

  const colX = (i: number) => i * cell
  const rowY = (r: number) => HEAD_H + r * ROW_H
  const todayIndex = days.findIndex(d => d.isToday)

  /** 換月份的那一欄補一個完整日期，不然八週的圖看不出跨到下個月了 */
  const monthMarks = useMemo(
    () => days.map((d, i) => i === 0 || d.date.slice(0, 7) !== days[i - 1].date.slice(0, 7)),
    [days]
  )

  const hoverCell = hover ? rows[hover.r]?.cells[hover.i] : null

  return (
    /*
     * 提示框刻意放在捲動容器**外面**。
     *
     * `overflow-x-auto` 會把 y 軸一起變成 auto（CSS 規定其中一軸不是 visible，
     * 另一軸就不能是 visible），所以掛在裡面的提示框會被下緣裁掉 ——
     * 格子只有 26px 高，提示框一定比容器高，等於每一格都看不到說明。
     * 放外面就要自己扣掉橫捲的位移，那是 scrollLeft 的用途。
     */
    <div className="relative">
      <div className="flex overflow-x-auto" ref={boxRef}
           onScroll={e => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}>
        {/* 左側人名欄改為橫向滾動固定 (Ref: CR-045) */}
        <div className="sticky left-0 z-10 shrink-0 bg-white border-r border-slate-200/80 dark:bg-slate-900 dark:border-slate-800"
             style={{ width: NAME_W }}>
          <div className="flex h-[50px] items-end pb-2.5 px-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            {T.dashboard.tableView.person}
          </div>
          {rows.map((row) => (
            <div key={row.userId ?? '__unassigned__'}
                 style={{ height: ROW_H }}
                 className={cx('flex items-center px-2 text-[12px] truncate', row.userId === null
                   ? 'text-slate-500 italic dark:text-slate-400'
                   : 'text-slate-700 font-medium dark:text-slate-200')}>
              {rowLabel(row)}
            </div>
          ))}
        </div>

        <svg width={gridW + SUM_W + PEAK_W} height={svgH} viewBox={`0 0 ${gridW + SUM_W + PEAK_W} ${svgH}`}
             role="img" aria-label={T.dashboard.workload.title}
             className="block select-none">
          <defs>
            <LeaveHatch id={hatchId} />
          </defs>

          {/* ── 欄標題：換月的日期 / 星期 / 幾號 ── */}
          {days.map((d, i) => (
            <g key={d.date}>
              {monthMarks[i] && (
                <text x={colX(i) + cell / 2} y={13} textAnchor="middle"
                      className="fill-slate-400 text-[10px] tabular-nums dark:fill-slate-400">
                  {shortDate(d.date)}
                </text>
              )}
              <text x={colX(i) + cell / 2} y={30} textAnchor="middle"
                    className={cx('text-[10px]', d.isWeekend
                      ? 'fill-slate-400 dark:fill-slate-400'
                      : 'fill-slate-500 dark:fill-slate-300')}>
                {WEEKDAY_LABELS[parseYmd(d.date).getDay()]}
              </text>
              <text x={colX(i) + cell / 2} y={44} textAnchor="middle"
                    className={cx('text-[11px] tabular-nums', d.isToday
                      ? 'fill-blue-600 font-semibold dark:fill-blue-300'
                      : d.isWeekend
                        ? 'fill-slate-400 dark:fill-slate-400'
                        : 'fill-slate-600 dark:fill-slate-300')}>
                {parseYmd(d.date).getDate()}
              </text>
            </g>
          ))}

          {/* 合計與最高一天的欄標題 */}
          <text x={gridW + SUM_W - 10} y={44} textAnchor="end"
                className="fill-slate-500 text-[11px] dark:fill-slate-400">
            {T.dashboard.workload.rowTotal}
          </text>
          <text x={gridW + SUM_W + PEAK_W - 10} y={44} textAnchor="end"
                className="fill-slate-500 text-[11px] dark:fill-slate-400">
            {T.dashboard.workload.peak}
          </text>

          {/* ── 每一列 ── */}
          <g
            onMouseOver={e => {
              const el = e.target as Element
              const r = el.getAttribute?.('data-r')
              const i = el.getAttribute?.('data-i')
              if (r !== null && r !== undefined && i !== null && i !== undefined) {
                setHover({ r: Number(r), i: Number(i) })
              }
            }}
            onMouseLeave={() => setHover(null)}
          >
            {rows.map((row, r) => (
              <g key={row.userId ?? '__unassigned__'}>
                {row.cells.map((c, i) => (
                  <Cell key={c.date} cell={c} cw={cell} x={colX(i)} y={rowY(r)}
                        r={r} i={i} capacity={capacity} max={max}
                        weekend={days[i]?.isWeekend ?? false} hatchId={hatchId} />
                ))}

                <text x={gridW + SUM_W - 10} y={rowY(r) + ROW_H / 2 + 4} textAnchor="end"
                      className="fill-slate-600 text-[11px] tabular-nums dark:fill-slate-300">
                  {fmt(row.total, metric)}
                </text>
                <text x={gridW + SUM_W + PEAK_W - 10} y={rowY(r) + ROW_H / 2 + 4}
                      textAnchor="end"
                      className={cx('text-[11px] tabular-nums', capacity > 0 && row.peak > capacity
                        ? 'fill-red-600 font-semibold dark:fill-red-400'
                        : 'fill-slate-600 dark:fill-slate-300')}>
                  {fmt(row.peak, metric)}
                </text>
              </g>
            ))}
          </g>

          {/* 今天：整欄框起來（含標題） */}
          {todayIndex >= 0 && (
            <rect x={colX(todayIndex)} y={2} width={cell} height={svgH - 4} rx={3}
                  fill="none" strokeWidth={1.5} pointerEvents="none"
                  className="stroke-blue-500 dark:stroke-blue-400" />
          )}
        </svg>
      </div>

      {hover && hoverCell && (
        <CellTooltip
          row={rows[hover.r]} cell={hoverCell} metric={metric} capacity={data.capacity}
          x={NAME_W + colX(hover.i) + cell / 2 - scrollLeft} y={rowY(hover.r) + ROW_H}
          boxWidth={boxW || svgW}
        />
      )}
    </div>
  )
}

function Cell({ cell, cw, x, y, r, i, capacity, max, weekend, hatchId }: {
  cell: WorkloadCell
  /** 一格多寬。由外面依容器算出來的，不是固定值 */
  cw: number
  x: number; y: number; r: number; i: number
  capacity: number; max: number; weekend: boolean; hatchId: string
}) {
  const over = capacity > 0 && cell.load > capacity
  const lv = level(cell.load, max)
  const base = over ? OVER : lv === 0 && weekend ? EMPTY_WEEKEND : RAMP[lv]
  const w = cw - GAP
  const h = ROW_H - GAP

  return (
    <g>
      {/* 這一塊是點擊／滑過的判定區（24×24，不小於 20px），資料掛在它身上 */}
      <rect x={x + GAP / 2} y={y + GAP / 2} width={w} height={h} rx={3}
            data-r={r} data-i={i}
            className={cx(base, 'cursor-default')} />

      {/* 超載：顏色之外再加一個看得見的記號，色盲也分得出來 */}
      {over && (
        <>
          <rect x={x + GAP / 2} y={y + GAP / 2} width={w} height={h} rx={3}
                fill="none" strokeWidth={1.5} pointerEvents="none"
                className="stroke-red-700 dark:stroke-red-300" />
          <path d={`M${x + GAP / 2 + w} ${y + GAP / 2} L${x + GAP / 2 + w} ${y + GAP / 2 + 7} `
                 + `L${x + GAP / 2 + w - 7} ${y + GAP / 2} Z`}
                pointerEvents="none" className="fill-white dark:fill-slate-900" />
        </>
      )}

      {/* 請假：斜線紋理疊上去，量的深淺留著 */}
      {cell.onLeave && (
        <rect x={x + GAP / 2} y={y + GAP / 2} width={w} height={h} rx={3}
              fill={`url(#${hatchId})`} pointerEvents="none" />
      )}
    </g>
  )
}

function CellTooltip({ row, cell, metric, capacity, x, y, boxWidth }: {
  row: WorkloadRow
  cell: WorkloadCell
  metric: DashboardMetric
  capacity: number
  x: number; y: number; boxWidth: number
}) {
  const C = T.dashboard.workload.cell
  const over = capacity > 0 && cell.load > capacity
  const lines: string[] = []

  if (cell.load <= 0 && cell.taskCount <= 0) lines.push(C.empty)
  else {
    if (metric === 'hours') lines.push(C.hours(numText(cell.load, metric)))
    lines.push(C.tasks(cell.taskCount))
  }
  if (over) lines.push(C.over(numText(cell.load - capacity, metric)))
  // 請假那天還壓著事情 —— 這格是整張圖最值得看的，講法要跟單純請假分開
  if (cell.onLeave) lines.push(cell.load > 0 || cell.taskCount > 0 ? C.onLeaveBusy : C.onLeave)

  const flip = x > boxWidth - 150
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[9rem] max-w-[15rem] rounded-md bg-white
                 p-2 text-xs shadow-lg ring-1 ring-slate-200
                 dark:bg-slate-800 dark:ring-slate-700"
      style={{
        left: x, top: y + 6,
        transform: flip ? 'translateX(-100%)' : 'translateX(-50%)',
      }}
    >
      <div className="font-medium text-slate-700 dark:text-slate-200">{rowLabel(row)}</div>
      <div className="mb-1 tabular-nums text-slate-500 dark:text-slate-400">{cell.date}</div>
      {lines.map(l => (
        <div key={l} className="leading-5 text-slate-600 dark:text-slate-300">{l}</div>
      ))}
    </div>
  )
}

// ── 表格版 ──────────────────────────────────────────────
function WorkloadTable({ data, metric }: { data: WorkloadResult; metric: DashboardMetric }) {
  const L = T.dashboard.workload.legend
  const th = 'px-2 py-1.5 font-medium whitespace-nowrap'
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm">
        <caption className="sr-only">{T.dashboard.workload.title}</caption>
        <thead>
          <tr className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <th scope="col" className={cx(th, 'text-left')}>{T.dashboard.tableView.person}</th>
            {data.days.map(d => (
              <th key={d.date} scope="col" className={cx(th, 'text-right tabular-nums')}
                  title={d.date}>
                {shortDate(d.date)}
              </th>
            ))}
            <th scope="col" className={cx(th, 'text-right')}>{T.dashboard.workload.rowTotal}</th>
            <th scope="col" className={cx(th, 'text-right')}>{T.dashboard.workload.peak}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map(row => (
            <tr key={row.userId ?? '__unassigned__'}
                className="border-t border-slate-100 dark:border-slate-800">
              <th scope="row" className={cx(th, 'text-left font-normal text-slate-700',
                                            'dark:text-slate-200')}>
                {rowLabel(row)}
              </th>
              {row.cells.map(c => {
                const over = data.capacity > 0 && c.load > data.capacity
                return (
                  <td key={c.date}
                      className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {numText(c.load, metric)}
                    {/* 超載與請假在表格裡一律寫成字，不靠顏色 */}
                    {(over || c.onLeave) && (
                      <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                        {[over ? L.over : null, c.onLeave ? L.leave : null]
                          .filter(Boolean).join(' ')}
                      </span>
                    )}
                  </td>
                )
              })}
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                {fmt(row.total, metric)}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                {fmt(row.peak, metric)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── 小工具 ──────────────────────────────────────────────

/** userId 是 null 的那一列一律用同一個說法，不看後端給的名字 */
const rowLabel = (row: WorkloadRow) =>
  row.userId === null ? T.dashboard.workload.unassigned : row.displayName

/**
 * 量落在色階的第幾階。0 自成一階（空的底色），其餘照整張圖的最大值切五段 ——
 * 拿每個人自己的最大值當上限的話，閒人跟忙人會畫成一樣深。
 */
function level(load: number, max: number): number {
  if (!(load > 0)) return 0
  if (!(max > 0)) return 1
  const r = load / max
  return r <= 0.2 ? 1 : r <= 0.4 ? 2 : r <= 0.6 ? 3 : r <= 0.8 ? 4 : 5
}

const round = (v: number, metric: DashboardMetric) =>
  metric === 'hours' ? Math.round(v * 10) / 10 : Math.round(v)

/** 只要數字（格子裡塞不下量詞，量詞交給欄外的合計與說明） */
const numText = (v: number, metric: DashboardMetric) => String(round(v, metric))

const fmt = (v: number, metric: DashboardMetric) =>
  metric === 'hours'
    ? T.dashboard.unit.hours(round(v, metric))
    : T.dashboard.unit.count(round(v, metric))

/**
 * useId 產出來的字含有 `:` / `«` 之類的字元，直接塞進 `url(#...)` 各家瀏覽器
 * 解讀不一。洗成只剩英數與底線再用，同一頁上的圖例與格子也不會共用同一個號。
 */
function svgId(raw: string, suffix: string): string {
  return `pmflow-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}-${suffix}`
}
