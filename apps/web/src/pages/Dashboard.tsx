import { useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Api, type DashboardMetric } from '../lib/api'
import { Button, Empty, Field, Input, Select, Spinner } from '../components/ui'
import BurndownChart from '../components/BurndownChart'
import WorkloadHeatmap from '../components/WorkloadHeatmap'
import { shiftYmd, todayYmd } from '../lib/date'
import { T } from '../strings'

/**
 * 儀表板 —— 燃盡圖與負載熱圖。
 *
 * 兩張圖**共用同一個計算單位與同一段日期**，這是刻意的：同一個畫面上
 * 兩張圖如果一張算張數、一張算工時，看的人一定會把它們讀成同一件事，
 * 然後拿兩個不同單位的數字互相對照。所以控制項只有一排，放在最上面。
 *
 * 日期一律 `YYYY-MM-DD` 字串進出（`<input type="date">` 本來就吃這個格式），
 * 中間不轉成 JS Date —— 轉一次就會在 UTC+8 位移一天。
 *
 * 區間沒設的時候**不送 from/to**，讓後端用它自己算出來的預設區間；
 * 輸入框顯示的就是後端回來的那一段，所以畫面上永遠看得到現在在看哪裡。
 *
 * 兩張圖各自打自己的端點，不共用一次查詢：熱圖要的是「每人每天」，
 * 燃盡圖要的是「每天一個總數」，合在一起算會讓其中一張等另一張。
 */
export default function Dashboard({ projectId }: {
  projectId: string
  /** 之後要從熱圖點進單張任務時會用到，先留著 */
  onOpenTask: (id: string) => void
}) {
  const [metric, setMetric] = useState<DashboardMetric>('count')
  /** null = 還沒自己選過，用後端的預設區間 */
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)

  // 反過來填（起比訖晚）就對調，不然兩張圖會一起空白，而人看不出是自己填反了
  const sent = range
    ? (range.from && range.to && range.from > range.to
        ? { from: range.to, to: range.from }
        : range)
    : null

  const params = { from: sent?.from || undefined, to: sent?.to || undefined, metric }
  const keyPart = [projectId, metric, params.from ?? '', params.to ?? '']

  const burndown = useQuery({
    queryKey: ['burndown', ...keyPart],
    queryFn: () => Api.burndown(projectId, params),
    enabled: !!projectId,
  })
  const workload = useQuery({
    queryKey: ['workload', ...keyPart],
    queryFn: () => Api.workload(projectId, params),
    enabled: !!projectId,
  })

  /** 輸入框裡顯示的那一段：自己選過就是自己選的，沒選過就是後端回來的 */
  const shown = range ?? {
    from: burndown.data?.from ?? workload.data?.from ?? '',
    to: burndown.data?.to ?? workload.data?.to ?? '',
  }

  /** 快捷區間一律從今天往後數 —— 熱圖看的是「接下來誰會爆掉」 */
  const quick = (weeks: number) => {
    const today = todayYmd()
    setRange({ from: today, to: shiftYmd(today, weeks * 7 - 1) })
  }

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">
        {T.dashboard.title}
      </h2>

      {/* ── 一排控制項，兩張圖共用 ── */}
      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-lg bg-white p-3
                      ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <Field label={T.dashboard.controls.metric}>
          <Select value={metric}
                  onChange={e => setMetric(e.target.value as DashboardMetric)}>
            <option value="count">{T.dashboard.controls.metricCount}</option>
            <option value="hours">{T.dashboard.controls.metricHours}</option>
          </Select>
        </Field>

        <div className="flex items-end gap-2">
          <span className="pb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            {T.dashboard.controls.range}
          </span>
          {/* 寬度給外層的 div，不覆蓋 Input 自己的 w-full —— 同一組寬度工具
              誰贏是看產生出來的 CSS 順序，不是 class 的先後 */}
          <div className="w-40">
            <Field label={T.dashboard.controls.from}>
              <Input type="date" value={shown.from}
                     onChange={e => setRange({ ...shown, from: e.target.value })} />
            </Field>
          </div>
          <div className="w-40">
            <Field label={T.dashboard.controls.to}>
              <Input type="date" value={shown.to}
                     onChange={e => setRange({ ...shown, to: e.target.value })} />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => quick(2)}>{T.dashboard.controls.rangeTwoWeeks}</Button>
          <Button onClick={() => quick(4)}>{T.dashboard.controls.rangeFourWeeks}</Button>
          <Button onClick={() => quick(8)}>{T.dashboard.controls.rangeEightWeeks}</Button>
          <Button variant="ghost" onClick={() => setRange(null)}>
            {T.dashboard.controls.reset}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <Panel query={burndown}>
          {d => <BurndownChart data={d} metric={metric} />}
        </Panel>
        <Panel query={workload}>
          {d => <WorkloadHeatmap data={d} metric={metric} />}
        </Panel>
      </div>
    </div>
  )
}

/**
 * 載入中 / 失敗 / 有資料 三種狀態長得一樣，兩張圖共用這一層。
 * 失敗時不能退回「沒有資料」的空狀態 —— 那會讓連線失敗看起來像專案是空的。
 */
function Panel<TData>({ query, children }: {
  query: { data: TData | undefined; isPending: boolean; isError: boolean; error: unknown }
  children: (data: TData) => ReactNode
}) {
  if (query.isPending) {
    return (
      <div className="rounded-lg bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <Spinner label={T.dashboard.loading} />
      </div>
    )
  }
  if (query.isError || !query.data) {
    const msg = query.error instanceof Error ? query.error.message : ''
    return (
      <div className="rounded-lg bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <Empty>
          <div className="font-medium text-slate-500 dark:text-slate-400">{T.common.failed}</div>
          {msg && <div className="mt-1">{msg}</div>}
        </Empty>
      </div>
    )
  }
  return <>{children(query.data)}</>
}
