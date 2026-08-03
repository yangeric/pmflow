import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type MouseEventHandler, type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background, BackgroundVariant, Handle, MarkerType, Panel, Position, ReactFlow,
  ReactFlowProvider, useNodesInitialized, useReactFlow,
  type Connection, type Edge, type FitViewOptions, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Api, ApiError, type InquiryState, type LinkType, type Task, type TaskStatus,
} from '../lib/api'
import { Button, Empty, INQUIRY_META, Spinner, cx } from '../components/ui'

/**
 * 關聯網路圖 —— 把「上下左右」三種關聯一次畫出來。
 *
 * 用 @xyflow/react (React Flow, MIT)。這裡跟行事曆不一樣，沒有自己畫：
 * 平移縮放、節點拖曳、邊的路由與端點標記自己寫要好幾百行，而且
 * React Flow 不需要第二套拖曳引擎（行事曆當初棄用 react-big-calendar，
 * 是因為它的拖曳外掛要另外帶 react-dnd，會跟 dnd-kit 搶指標事件）。
 *
 * 但**佈局是自己算的**，沒有用官方文件推薦的 elkjs —— 它是 EPL-2.0，
 * 過不了 ci.yml 的授權白名單。dagre 授權乾淨但 2018 年後就沒動了。
 * 我們要的只是「依賴由左往右分層」，自己寫的最長路徑分層約六十行就夠。
 *
 * 介面一律不出現 FS / SS / FF / SF。邊上掛的是短句（完成後開始…），
 * 側欄的關聯清單講完整句型，跟任務詳情頁同一套說法。
 */

// ── 中文說法：與 TaskDrawer 同一套，改的時候兩邊要一起改 ──────────
const LINK_CHIP: Record<LinkType, string> = {
  FS: '完成後開始', SS: '同時開始', FF: '同時完成', SF: '開始後完成',
  RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
}

const LINK_LABEL: Record<LinkType, string> = {
  FS: '等待任務完成，才能開始',
  SS: '等待任務開始，才能開始',
  FF: '等待任務完成，才能完成',
  SF: '等待任務開始，才能完成',
  RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
}

const SCHEDULING = ['FS', 'SS', 'FF', 'SF'] as const
type SchedulingType = (typeof SCHEDULING)[number]
const isScheduling = (t: LinkType): t is SchedulingType =>
  (SCHEDULING as readonly string[]).includes(t)

/**
 * 四種排程依賴各給一個顏色。刻意不「只靠顏色」區分 ——
 * 每條線上都掛著中文短句，色弱或列印成黑白也讀得出來，顏色只是加速掃視。
 */
const SCHEDULING_COLOR: Record<SchedulingType, string> = {
  FS: '#dc2626', SS: '#ea580c', FF: '#7c3aed', SF: '#0891b2',
}
/**
 * 虛線只有一個意思：**這條線不會推動日期**。
 *
 * 底下兩種都是虛線，所以一定要在別的地方分得開 —— 語意關聯畫得深、畫長虛線，
 * 階層畫得淺、畫圓點。加上線上本來就有的中文短句（相關／阻擋／…／包含），
 * 就算色弱或列印成黑白也不會混在一起。
 */
const SEMANTIC_COLOR = '#64748b'
const SEMANTIC_DASH = '7 4'
const HIERARCHY_COLOR = '#cbd5e1'
const HIERARCHY_DASH = '1 5'
/** 聚焦時的階層線。紫色跟節點上的「大項目」徽章同一個色系，兩邊指的是同一件事 */
const HIERARCHY_FOCUS_COLOR = '#8b5cf6'

/**
 * 線上的字不加白底方框。
 *
 * 方框會把線壓斷一整段，密的地方看起來像線斷掉了。改成在字的外圍描一圈
 * 跟畫布同色的邊（paint-order: stroke 先描邊再填字），字一樣讀得清楚，
 * 但線只被字本身的筆畫遮住，走向仍然看得出來。
 */
const HALO = '#f8fafc'          // = 畫布的 bg-slate-50
const labelText = (color: string, faded: boolean) => ({
  fontSize: 10,
  fill: color,
  opacity: faded ? 0.15 : 1,
  paintOrder: 'stroke' as const,
  stroke: HALO,
  strokeWidth: 4,
  strokeLinejoin: 'round' as const,
})

/**
 * 刻意不替圖例保留空間。
 *
 * 試過在 fitView 裡留出圖例的高度，結果在矮一點的視窗上（實測畫布只有 368px 高）
 * 光圖例就吃掉快一半，整張圖被壓到看不清字。圖例改成工具列上的切換鈕、預設收起
 * —— 每條線上本來就有中文短句，圖例是輔助不是必需。
 */
const FIT_OPTIONS: FitViewOptions = {
  duration: 200,
  padding: { top: '16px', right: '24px', bottom: '16px', left: '16px' },
}

// ── 佈局參數 ────────────────────────────────────────────
/** 欄距要留得下匯合點加它前後的兩段線與標籤，見 JUNCTION_GAP */
const COL_GAP = 340
const ROW_GAP = 96
/** 一層塞不下就折成下一個子欄，不然會拉成一條看不完的長條 */
const MAX_PER_COL = 10
/**
 * 節點寬度＝Tailwind 的 w-64。算匯合點的位置要用，所以寫成常數。
 * 從 w-56（224）加寬過一次：一張任務同時「卡住」又「同時開始」時，
 * 兩個徽章擠不進 224px，會折到第二行去。
 */
const NODE_W = 256
/** 節點還沒量到高度前的估計值，只影響匯合點第一幀的垂直位置 */
const NODE_H_FALLBACK = 76
/** 匯合點是一個小圓點 —— 它只是個時間點，不佔垂直空間 */
const JUNCTION_SIZE = 10
/** 匯合點離任務節點多遠。剩下的欄距要放得下進來（或出去）的那條線的標籤 */
const JUNCTION_GAP = 46

type TaskNodeData = {
  ref: string
  title: string
  /** 顏色不存在節點裡，每次算 —— 見下面建立節點那段的說明 */
  statusKey: string
  color: string
  progress: number
  inquiryState: InquiryState
  isEpic: boolean
  /** 框裡直接放著幾張任務。0＝不是框 */
  childCount: number
  isMilestone: boolean
  dimmed: boolean
  focused: boolean
  /**
   * 只因為「階層」而被留亮的鄰居 —— 選中任務的上層或下層，兩者之間**沒有依賴**。
   * null＝不是這種情況（沒在聚焦、或它跟選中的那張真的有關聯線）。
   */
  kin: 'parent' | 'child' | null
  /** 卡住這張任務的上游（任務編號）。空陣列＝沒被卡住，或使用者關掉了這個標記 */
  blockedBy: string[]
  /**
   * 可以跟這張任務同時做的任務（任務編號），依「怎麼個同時法」分開。同上，關掉標記時是空的。
   *
   * 三者互斥：同一對任務只會落在其中一類，先判同時開始／同時完成，都不是才算單純重疊。
   */
  parallel: ParallelPeers
}

/** 同時開始／同時完成／期間重疊，各自列出對方的任務編號 */
type ParallelPeers = { sameStart: string[]; sameFinish: string[]; overlap: string[] }
const NO_PARALLEL: ParallelPeers = { sameStart: [], sameFinish: [], overlap: [] }
type TaskNode = Node<TaskNodeData, 'task' | 'box'>

// ── 最下面那兩排說明的文字 ──────────────────────────────
// 同一段文字要給兩個地方用：游標停著出現的 title，以及點一下釘在列上方的說明。
// 寫成常數才不會兩邊各寫一份、改一邊忘另一邊。

const OPERATION_HELP =
  '・點節點：只留亮它的鄰居，其餘淡出。再點一次取消\n' +
  '・雙擊節點：開啟那張任務\n' +
  '・從節點右側的圓點拉到另一張任務：建立關聯（種類用上面的「拉線建立」選）\n' +
  '・點線：刪除那條關聯\n' +
  '・拖節點可以自己排版，按「重新排列」放回自動位置\n' +
  '・「框選」開著時左鍵拉出範圍選多張，一起拖曳；右鍵平移畫面\n' +
  '・滾輪縮放，或用左上角的＋／－'

const SCHEDULING_HELP: Record<LinkType, string> = {
  FS: '等待任務完成，才能開始。上游做完的隔天下游才動得了 —— 最常見的一種',
  SS: '等待任務開始，才能開始。兩張要在同一天起跑，人力得同時到位',
  FF: '等待任務完成，才能完成。兩張要在同一天收尾，驗收會撞在一起',
  SF: '等待任務開始，才能完成。少見，通常用在交接：新的開始了，舊的才能結束',
  RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
}

const SEMANTIC_HELP =
  '相關／阻擋／重複於／需要。\n' +
  '虛線＝只是註記兩張任務的關係，改其中一張的日期不會推動另一張。'

const BOX_HELP =
  '大項目畫成一個框，底下的任務就排在框裡面。\n' +
  '框裡面是「這一包」的內容，不是先後關係 ——\n' +
  '大項目的日期與進度由裡面那些任務彙總出來。\n' +
  '框本身也是一張任務，可以指向後續任務：\n' +
  '一支從框拉出去的箭頭＝「這一整包做完，才能接下去」。'

const JUNCTION_HELP =
  '「同時開始」與「同時完成」不是兩張任務之間的一支箭頭，而是一個時間點。\n' +
  '橘＝同時開始（一支箭頭進、多支出）\n' +
  '紫＝同時完成（多支進、一支出）'

const ICON_HELP: Array<{ label: string; className?: string; text: string }> = [
  { label: '🚧 卡住',
    text: '這張任務現在動不了：上游還沒完成，或同時開始的那一張還沒開始。\n' +
          '滑到節點上的紅色徽章可以看它在等誰 —— 會直接指到真正的源頭，\n' +
          '不是中間那一張。' },
  { label: '⇉ 同時開始', className: 'text-amber-700',
    text: '跟別的任務同一天開始。排人力時這幾張要一起看，同一天都得到位。' },
  { label: '⇥ 同時完成', className: 'text-purple-700',
    text: '跟別的任務同一天完成。驗收、結案會撞在同一天。' },
  { label: '⇉ 並行', className: 'text-teal-700',
    text: '期間重疊、彼此沒有先後，可以同時派不同的人做。\n' +
          '預設不顯示，要在上面的「並行」打勾。' },
  { label: '內含 N 張', className: 'text-violet-700',
    text: '框的標題列上寫的數字＝這個框裡直接放著幾張任務。\n' +
          '框的日期與進度由裡面那些任務彙總出來。' },
  { label: '里程碑', className: 'text-amber-700',
    text: '只有一個時間點的任務，用來標「這天要交出什麼」。' },
]

const INQUIRY_HELP: Record<'AWAITING' | 'OVERDUE' | 'PARTIAL' | 'REPLIED', string> = {
  AWAITING: '發文追蹤：發出去了，還在等對方回覆，也還沒到期望回覆日。',
  OVERDUE:  '發文追蹤：過了期望回覆日還沒回。逾期是查詢時算出來的，不是存下來的狀態。',
  PARTIAL:  '發文追蹤：問了好幾個單位，有的回了、有的還沒。',
  REPLIED:  '發文追蹤：都回覆了。回覆的單位可能跟提問的單位不同（轉單位）。',
}

/** 節點上那排小徽章的共同樣式。一律 shrink-0＋不換行，擠不下就被裁掉，不折行 */
const BADGE = 'shrink-0 whitespace-nowrap rounded px-1 text-[10px]'

// ── 節點 ────────────────────────────────────────────────

/**
 * 外框的樣式。一般任務與大項目的框共用一套，只差在大小與底色 ——
 * 兩者都是任務，被卡住、被聚焦、只因階層而亮，三種狀態的畫法都要一致。
 */
function frameClass(data: TaskNodeData): string {
  return cx(
    'rounded-lg border shadow-sm transition-opacity',
    data.focused ? 'border-blue-500 ring-2 ring-blue-500/30'
      // 卡住＝現在動不了，是圖上最該被看到的狀態，給整圈紅框加紅暈
      : data.blockedBy.length ? 'border-red-500 ring-2 ring-red-500/25'
      // 紫框＝只是階層上的鄰居（上層或下層），不是依賴。
      // 原本用灰虛線，使用者看不出那是什麼意思，改成跟「大項目」徽章同色系
      : data.kin ? 'border-violet-400 ring-2 ring-violet-200'
      : 'border-slate-300',
    data.dimmed && 'opacity-20'
  )
}

/**
 * 大項目＝一個框，底下的任務排在框裡面（它們是 React Flow 的子節點，畫在框上面）。
 *
 * 框裡面刻意留空、只有很淡的底色：真正的內容是那些子節點，框只負責圈範圍。
 * 標題列做成一整條可以點的區域，點它就是點這張任務（聚焦、雙擊開啟都照舊）。
 */
function BoxNodeView({ data }: NodeProps<TaskNode>) {
  const meta = INQUIRY_META[data.inquiryState]
  return (
    <div className={cx(frameClass(data), 'h-full w-full bg-violet-50/40')}>
      <Handle id="in" type="target" position={Position.Left}
              className="!h-2 !w-2 !border !border-white !bg-slate-400" />
      <div className="h-1 rounded-t-lg" style={{ backgroundColor: data.color }} />
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="shrink-0 font-mono text-[10px] text-slate-500">{data.ref}</span>
        {/* 「大項目」三個字沒有告訴使用者任何事 —— 框已經把「底下還有東西」畫出來了，
            這裡改成講數量，一眼知道這一包有多大 */}
        <span className={BADGE + ' bg-violet-100 font-medium text-violet-700'}
              title="這個框裡直接放著幾張任務。框的日期與進度由裡面那些任務彙總出來">
          內含 {data.childCount} 張
        </span>
        {data.kin && (
          <span className={BADGE + ' bg-violet-100 font-medium text-violet-700'}
                title={data.kin === 'parent'
                  ? '這是選中任務的上層，兩者之間沒有依賴關係'
                  : '這是選中任務底下的任務，兩者之間沒有依賴關係'}>
            {data.kin === 'parent' ? '這張的上層' : '這張的下層'}
          </span>
        )}
        {data.blockedBy.length > 0 && (
          <span className={BADGE + ' bg-red-50 font-medium text-red-700'}
                title={`卡住：要等 ${data.blockedBy.join('、')}`}>卡住</span>
        )}
        <span className="min-w-0 truncate text-sm font-semibold text-slate-800">
          {data.title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {data.inquiryState !== 'NONE' && (
            <span className="text-[11px]" title={meta.label} aria-label={meta.label}>
              {meta.icon}
            </span>
          )}
          <span className="h-1 w-14 overflow-hidden rounded bg-white">
            <span className="block h-1 rounded"
                  style={{ width: `${data.progress}%`, backgroundColor: data.color }} />
          </span>
          <span className="text-[10px] tabular-nums text-slate-500">{data.progress}%</span>
        </span>
      </div>
      <Handle id="out" type="source" position={Position.Right}
              className="!h-2 !w-2 !border !border-white !bg-slate-400" />
    </div>
  )
}

function TaskNodeView({ data }: NodeProps<TaskNode>) {
  const meta = INQUIRY_META[data.inquiryState]
  return (
    <div className={cx(frameClass(data), 'w-64 bg-white')}>
      <Handle id="in" type="target" position={Position.Left}
              className="!h-2 !w-2 !border !border-white !bg-slate-400" />
      <div className="h-1 rounded-t-lg" style={{ backgroundColor: data.color }} />
      <div className="px-2.5 py-2">
        {/* 不換行：徽章折到第二行會把節點撐高，同一排任務高低不齊，圖就散了。
            寧可字少一點也要留在同一行，完整說法在 title 上 */}
        <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
          <span className="shrink-0 font-mono text-[10px] text-slate-500">{data.ref}</span>
          {/* 先講「這張為什麼亮著」，再講它自己是什麼 */}
          {data.kin && (
            <span className={BADGE + ' bg-violet-100 font-medium text-violet-700'}
                  title={data.kin === 'parent'
                    ? '這是選中任務的上層大項目，兩者之間沒有依賴關係'
                    : '這是選中任務底下的任務，兩者之間沒有依賴關係'}>
              {data.kin === 'parent' ? '這張的上層' : '這張的下層'}
            </span>
          )}
          {data.isEpic && (
            <span className={BADGE + ' bg-violet-50 text-violet-700'}
                  title="這張任務底下還可以掛別的任務">大項目</span>
          )}
          {data.isMilestone && (
            <span className={BADGE + ' bg-amber-50 text-amber-700'}>里程碑</span>
          )}
          {/*
           * 卡住與並行都寫成一句看得懂的話掛在 title 上。徽章本身只留兩三個字，
           * 一張任務可能同時掛好幾個，寫長了會把標題擠掉 —— 細節留給滑過去看。
           */}
          {data.blockedBy.length > 0 && (
            <span className={BADGE + ' bg-red-50 font-medium text-red-700'}
                  title={`卡住：要等 ${data.blockedBy.join('、')}`}>卡住</span>
          )}
          {/* 同一張任務可能同時掛「卡住」與「同時開始」，那不是矛盾：
              上游還沒開始所以現在動不了，它一開始，兩張就並肩跑。
              分得出來的關鍵是上面那句「要等 ⋯ 開始」還是「要等 ⋯ 完成」。
              徽章顏色跟圖上的匯合點同一組：橘＝同時開始、紫＝同時完成 */}
          {data.parallel.sameStart.length > 0 && (
            <span className={BADGE + ' bg-amber-50 font-medium text-amber-700'}
                  title={`跟 ${data.parallel.sameStart.join('、')} 同一天開始`}>
              同時開始 {data.parallel.sameStart.length}
            </span>
          )}
          {data.parallel.sameFinish.length > 0 && (
            <span className={BADGE + ' bg-purple-50 font-medium text-purple-700'}
                  title={`跟 ${data.parallel.sameFinish.join('、')} 同一天完成`}>
              同時完成 {data.parallel.sameFinish.length}
            </span>
          )}
          {data.parallel.overlap.length > 0 && (
            <span className={BADGE + ' bg-teal-50 font-medium text-teal-700'}
                  title={`可以跟 ${data.parallel.overlap.join('、')} 同時做`}>
              並行 {data.parallel.overlap.length}
            </span>
          )}
          {data.inquiryState !== 'NONE' && (
            <span className="ml-auto shrink-0 text-[11px]"
                  title={meta.label} aria-label={meta.label}>
              {meta.icon}
            </span>
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug text-slate-800">
          {data.title}
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded bg-slate-100">
          <div className="h-1 rounded"
               style={{ width: `${data.progress}%`, backgroundColor: data.color }} />
        </div>
      </div>
      <Handle id="out" type="source" position={Position.Right}
              className="!h-2 !w-2 !border !border-white !bg-slate-400" />
    </div>
  )
}

/**
 * 匯合點 —— 「同時開始」與「同時完成」不是兩張任務之間的一支箭頭。
 *
 * 兩張同一天起跑的任務，畫成 A →  B 就是在說 B 因為 A 才動；實際上它們是
 * **同一個時間點分出去的兩路**。所以這兩種依賴改畫成一個小圓點：
 *
 *   同時開始：一支箭頭進來 → 圓點 → 多支箭頭出去（分岔，放在該欄的左邊）
 *   同時完成：多支箭頭進來 → 圓點 → 一支箭頭出去（合流，放在該欄的右邊）
 *
 * 圓點放在群組的垂直中點，扇形自己會張開，不需要一根跟群組一樣高的直條
 * 去「連住」它們 —— 那條線看起來像另一種依賴，反而更難讀。
 *
 * 圓點不是任務，不能點、不能拖、不能從它拉線；它只是把「同時」這件事畫出來。
 */
type JunctionData = { kind: 'fork' | 'join'; dimmed: boolean }
type JunctionNode = Node<JunctionData, 'junction'>

function JunctionNodeView({ data }: NodeProps<JunctionNode>) {
  const fork = data.kind === 'fork'
  const color = SCHEDULING_COLOR[fork ? 'SS' : 'FF']
  return (
    <div className={cx('relative h-full w-full transition-opacity', data.dimmed && 'opacity-20')}
         title={fork ? '同時開始：從這個時間點分出去' : '同時完成：在這個時間點收在一起'}>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false}
              className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      {/* 白色外圈讓圓點在穿過它的線上仍然看得出來 */}
      <div className="h-full w-full rounded-full ring-2 ring-white"
           style={{ backgroundColor: color }} />
      {/* 圓點只有 10px 寬，字掛在下面才不會把線壓住。同樣用描邊代替白底方框 */}
      <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap
                       text-[10px] leading-4"
            style={{
              color,
              textShadow: `0 0 3px ${HALO}, 0 0 3px ${HALO}, 0 0 3px ${HALO}`,
            }}>
        {fork ? '同時開始' : '同時完成'}
      </span>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false}
              className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
    </div>
  )
}

const nodeTypes = { task: TaskNodeView, box: BoxNodeView, junction: JunctionNodeView }

type FlowNode = TaskNode | JunctionNode

/** 任務編號補零，讓 PMF-7 排在 PMF-10 前面 */
function pad(ref: string): string {
  return ref.slice(ref.lastIndexOf('-') + 1).padStart(8, '0')
}

/**
 * 版面：大項目是一個框，它底下的任務排在框裡面。
 *
 * 為什麼是框而不是連一條「包含」線：使用者連問三次「這兩張到底什麼關係」。
 * 一條灰虛線得先看懂圖例才知道是階層，框不用 —— 東西在框裡面就是它的一部分。
 * 而且框本身還是一張任務，可以指向後續任務，「這一整包做完才能接下去」
 * 就變成一支從框拉出去的箭頭，那正是使用者要的表達方式。
 *
 * 每一層（最外層、以及每個框的裡面）都各自跑同一套排法：
 *
 *   最長路徑分層：排程類依賴由左往右流。語意關聯不參與分層 ——
 *   它們不推動日期，讓它們影響 X 座標只會把「誰卡住誰」弄糊。
 *
 *   四種排程依賴裡只有兩種真的有先後。「同時開始」「同時完成」講的是
 *   兩張任務貼在時間軸的同一個點，把它們也算成往右一欄，畫出來會變成
 *   一條假的接力賽。所以先把「同時」連起來的任務併成同一欄，
 *   再拿「完成後開始」「開始後完成」去排欄與欄之間的先後。
 *
 * 跨層的依賴（框裡的任務指到框外面）不參與內層排序，但線照畫 ——
 * React Flow 的邊本來就跨得過父子邊界。
 */

/** 一般任務的尺寸。高度用固定值而不是量到的，量到的值會讓版面在第一次繪製後跳一下 */
const LEAF_W = NODE_W
const LEAF_H = 92
/** 框的內距與標題列高度 */
const BOX_PAD = 18
const BOX_HEADER = 52

type Box = { w: number; h: number }

type LayoutResult = {
  /** 相對於「父框內容區」的位置。沒有父框的就是畫布座標 */
  rel: Map<string, { x: number; y: number }>
  /** 每個節點佔多大。框的尺寸是裡面排完之後算出來的 */
  size: Map<string, Box>
  /** 畫布上的絕對位置。匯合點要用（它掛在最外層） */
  abs: Map<string, { x: number; y: number }>
  /** 有小孩的任務＝框 */
  boxes: Set<string>
  /** 框裡直接放著幾張任務 */
  childCount: Map<string, number>
}

function layout(
  ids: string[],
  parentOf: Map<string, string | null>,
  refOf: Map<string, string>,
  schedEdges: Array<{ sourceId: string; targetId: string; linkType: LinkType }>
): LayoutResult {
  const present = new Set(ids)
  const usable = schedEdges.filter(e => present.has(e.sourceId) && present.has(e.targetId))
  const isSimultaneous = (t: LinkType) => t === 'SS' || t === 'FF'

  /** 每個框底下有哪些任務。父層不在畫面上的（被篩掉了）算最外層 */
  const kidsOf = new Map<string | null, string[]>()
  for (const id of ids) {
    const p = parentOf.get(id)
    const key = p && present.has(p) ? p : null
    kidsOf.set(key, [...(kidsOf.get(key) ?? []), id])
  }
  const boxes = new Set(ids.filter(id => (kidsOf.get(id) ?? []).length > 0))

  /** 任務編號補零之後的完整路徑，同一個框底下的排在一起 */
  const sortKey = new Map<string, string>()
  for (const id of ids) {
    const chain: string[] = []
    let cur: string | null | undefined = id
    for (let depth = 0; cur && depth < 10; depth++) {
      chain.unshift(pad(refOf.get(cur) ?? ''))
      cur = parentOf.get(cur) ?? null
    }
    sortKey.set(id, chain.join('/'))
  }

  const rel = new Map<string, { x: number; y: number }>()
  const size = new Map<string, Box>()

  /** 這個節點多大：一般任務是固定尺寸，框要先把裡面排完才知道 */
  const measure = (id: string): Box => {
    const cached = size.get(id)
    if (cached) return cached
    const kids = kidsOf.get(id) ?? []
    let box: Box
    if (kids.length) {
      const inner = place(kids)
      box = {
        w: Math.max(inner.w + BOX_PAD * 2, LEAF_W),
        h: inner.h + BOX_HEADER + BOX_PAD,
      }
    } else {
      box = { w: LEAF_W, h: LEAF_H }
    }
    size.set(id, box)
    return box
  }

  /** 一個子欄裡最寬的那個 */
  const colWidth = (col: string[]) =>
    col.reduce((w, id) => Math.max(w, measure(id).w), LEAF_W)

  /**
   * 把一組同層的任務排好，回傳它們佔掉的範圍。
   * 位置寫進 rel，相對於這一層的左上角。
   */
  function place(members: string[]): Box {
    for (const id of members) measure(id)
    const inLevel = new Set(members)

    // ── 併欄（union-find）：同時開始／同時完成的併成一欄 ──
    const uf = new Map(members.map(id => [id, id]))
    const find = (id: string): string => {
      let root = id
      while (uf.get(root) !== root) root = uf.get(root)!
      for (let cur = id; uf.get(cur) !== root;) {
        const nx = uf.get(cur)!
        uf.set(cur, root)
        cur = nx
      }
      return root
    }
    for (const e of usable) {
      if (!isSimultaneous(e.linkType)) continue
      if (!inLevel.has(e.sourceId) || !inLevel.has(e.targetId)) continue
      const a = find(e.sourceId)
      const b = find(e.targetId)
      if (a !== b) uf.set(a, b)
    }

    // ── 欄與欄之間的先後 ──
    const cols = [...new Set(members.map(find))]
    const next = new Map<string, string[]>()
    const indeg = new Map<string, number>()
    for (const c of cols) { next.set(c, []); indeg.set(c, 0) }
    for (const e of usable) {
      if (isSimultaneous(e.linkType)) continue
      if (!inLevel.has(e.sourceId) || !inLevel.has(e.targetId)) continue
      const from = find(e.sourceId)
      const to = find(e.targetId)
      // 併欄之後兩端落在同一欄（A 同時開始 B、又 B 完成後開始 A）——
      // 這種矛盾後端擋環時擋不掉，畫面上就當它沒有先後
      if (from === to) continue
      next.get(from)!.push(to)
      indeg.set(to, indeg.get(to)! + 1)
    }

    const layerOf = new Map<string, number>()
    const queue = cols.filter(c => indeg.get(c) === 0)
    for (const c of queue) layerOf.set(c, 0)
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i]
      for (const to of next.get(c)!) {
        layerOf.set(to, Math.max(layerOf.get(to) ?? 0, layerOf.get(c)! + 1))
        indeg.set(to, indeg.get(to)! - 1)
        if (indeg.get(to) === 0) queue.push(to)
      }
    }
    // 後端擋過環，照理不會有剩。真的有就統一放第 0 層 ——
    // 畫得出來比畫不出來重要，環本身在甘特頁會另外報
    for (const c of cols) if (!layerOf.has(c)) layerOf.set(c, 0)

    // 同一欄的要上下相鄰，不然「同時開始」的兩張會被別人插在中間
    const colKey = new Map<string, string>()
    for (const id of members) {
      const c = find(id)
      const k = sortKey.get(id) ?? ''
      if (!colKey.has(c) || k < colKey.get(c)!) colKey.set(c, k)
    }

    // 這一層裡跟誰都沒關係的沉到最下面：它們全部落在第 0 層，
    // 照編號排會插在最上面，看起來像整張圖的開頭，其實只是還沒被接上
    const connected = new Set<string>()
    for (const e of usable) {
      if (!inLevel.has(e.sourceId) || !inLevel.has(e.targetId)) continue
      connected.add(e.sourceId)
      connected.add(e.targetId)
    }

    const byLayer = new Map<number, string[]>()
    for (const id of members) {
      const l = layerOf.get(find(id))!
      byLayer.set(l, [...(byLayer.get(l) ?? []), id])
    }

    let x = 0
    let maxBottom = 0
    for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
      const bucket = byLayer.get(l)!.sort((a, b) => {
        const la = connected.has(a) ? 0 : 1
        const lb = connected.has(b) ? 0 : 1
        if (la !== lb) return la - lb
        const ca = colKey.get(find(a)) ?? ''
        const cb = colKey.get(find(b)) ?? ''
        return ca !== cb
          ? ca.localeCompare(cb)
          : (sortKey.get(a) ?? '').localeCompare(sortKey.get(b) ?? '')
      })

      // 這一層折成幾個子欄。框比一般任務高很多，所以按高度收，不是按張數
      const columns: string[][] = [[]]
      let used = 0
      for (const id of bucket) {
        const h = measure(id).h
        const cur = columns[columns.length - 1]
        if (cur.length >= MAX_PER_COL || (used > 0 && used + h > MAX_PER_COL * ROW_GAP)) {
          columns.push([])
          used = 0
        }
        columns[columns.length - 1].push(id)
        used += h + (ROW_GAP - LEAF_H)
      }

      let widest = 0
      let colX = x
      for (const col of columns) {
        let y = 0
        for (const id of col) {
          rel.set(id, { x: colX, y })
          y += measure(id).h + (ROW_GAP - LEAF_H)
        }
        maxBottom = Math.max(maxBottom, y - (ROW_GAP - LEAF_H))
        const w = colWidth(col)
        widest = Math.max(widest, colX - x + w)
        colX += w + (COL_GAP - LEAF_W)
      }
      x += Math.max(widest, LEAF_W) + (COL_GAP - LEAF_W)
    }

    return { w: Math.max(x - (COL_GAP - LEAF_W), 0), h: maxBottom }
  }

  place(kidsOf.get(null) ?? [])

  // React Flow 的子節點座標是「相對於父節點的左上角」，不是相對於框的內容區。
  // 排版時是照內容區算的，所以這裡把標題列與內距補回去 ——
  // 少了這一步，第一張子任務會直接蓋在框的標題上。
  for (const [parent, kids] of kidsOf) {
    if (!parent) continue
    for (const k of kids) {
      const r = rel.get(k)
      if (r) rel.set(k, { x: r.x + BOX_PAD, y: r.y + BOX_HEADER })
    }
  }

  // 匯合點掛在最外層，要的是畫布座標 —— 把每一層的位移一路加上來
  const abs = new Map<string, { x: number; y: number }>()
  const walk = (id: string, ox: number, oy: number) => {
    const r = rel.get(id) ?? { x: 0, y: 0 }
    const x = ox + r.x
    const y = oy + r.y
    abs.set(id, { x, y })
    for (const k of kidsOf.get(id) ?? []) walk(k, x, y)
  }
  for (const id of kidsOf.get(null) ?? []) walk(id, 0, 0)

  const childCount = new Map<string, number>()
  for (const id of boxes) childCount.set(id, (kidsOf.get(id) ?? []).length)

  return { rel, size, abs, boxes, childCount }
}

export default function GraphView(props: {
  projectId: string
  tasks: Task[]
  statuses: TaskStatus[]
  onOpen: (id: string) => void
}) {
  // useReactFlow（fitView / zoom）必須在 Provider 底下才拿得到
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  )
}

function GraphCanvas({
  projectId, tasks, statuses, onOpen,
}: {
  projectId: string
  tasks: Task[]
  statuses: TaskStatus[]
  onOpen: (id: string) => void
}) {
  const qc = useQueryClient()
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const nodesInitialized = useNodesInitialized()

  /** 使用者拖過的節點位置。只存被動過的那幾個，其餘照自動佈局 */
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({})
  /**
   * React Flow 量到的節點尺寸。這個一定要自己收好再疊回節點上。
   *
   * 節點是每次 render 重算的（見下面 baseNodes / styledNodes），而 React Flow
   * 收到新的 nodes 陣列時是「照著 node.measured 重建內部尺寸」—— 我們給的物件
   * 沒有 measured，等於每次 render 都把它剛量到的尺寸抹成 undefined。結果是
   * 節點永遠停在量測前的 visibility:hidden、nodesInitialized 永遠是 false，
   * fitView 也就永遠等不到。
   */
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({})
  const [focusId, setFocusId] = useState<string | null>(null)
  const [showSemantic, setShowSemantic] = useState(true)
  /** 標出「還不能動手」的任務。預設開著 —— 這是進來最想先看到的一件事 */
  const [showBlocked, setShowBlocked] = useState(true)
  /** 標出「可以同時做」的任務。預設關著，因為它是排人力時才會用的分析視角 */
  const [showParallel, setShowParallel] = useState(false)
  /** 開著時左鍵是拉框選取，不是平移畫面 */
  const [boxSelect, setBoxSelect] = useState(false)
  /** 按「重新排列」時 +1，把拖亂的節點放回自動佈局的位置 */
  const [relayout, setRelayout] = useState(0)
  const [newLinkType, setNewLinkType] = useState<LinkType>('FS')
  const [error, setError] = useState<string | null>(null)
  /** 按過「重新排列」，要求即使節點沒變也重新框一次 */
  const fitPending = useRef(false)
  /** 上一次框過的節點集合，用來判斷「換資料了，該重新框」 */
  const lastFitKey = useRef('')
  /** 使用者自己平移縮放或拖過節點之後，就不要再自動搶走他的視角 */
  const userAdjusted = useRef(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const { data: graph, isLoading } = useQuery({
    queryKey: ['graph', projectId],
    queryFn: () => Api.graph(projectId),
  })

  /**
   * 相依刻意用「攤平成字串的內容」而不是 statuses 陣列本身。
   *
   * 上層傳進來的是 `project?.statuses ?? []`，每次 render 都是一個新陣列。
   * 直接依賴它的話 statusColor 每次都是新函式，styledNodes 跟著每次都產生
   * 全新的節點物件，React Flow 會一直把節點當成新的、反覆重新量測，結果是
   * 節點永遠停在 visibility:hidden（量到之前它會先藏起來），連帶 fitView
   * 也永遠等不到 nodesInitialized。這個 bug 表現成「有時候正常、有時候整張圖
   * 縮不起來還被切掉」，很難看出來跟顏色有關。
   */
  const statusColorKey = statuses.map(s => `${s.key}:${s.color}`).join('|')
  const statusColor = useMemo(() => {
    const m = new Map(statuses.map(s => [s.key, s.color]))
    return (key: string) => m.get(key) ?? '#94a3b8'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusColorKey])

  // 側欄選了大項目時，主視圖只顯示那棵子樹 —— 關聯圖跟其他視圖看同一份 tasks，
  // 免得「清單看到 5 張、關聯圖卻畫出 40 張」這種對不起來的情況。
  const visibleIds = useMemo(() => new Set(tasks.map(t => t.id)), [tasks])

  const shownNodes = useMemo(
    () => (graph?.nodes ?? []).filter(n => visibleIds.has(n.id)),
    [graph, visibleIds]
  )

  const schedEdges = useMemo(
    () => (graph?.edges ?? []).filter(
      e => isScheduling(e.linkType) && visibleIds.has(e.sourceId) && visibleIds.has(e.targetId)
    ),
    [graph, visibleIds]
  )

  /**
   * 把「同時開始」「同時完成」收成匯合點（見 JunctionNodeView 的說明）。
   *
   * 用同一種依賴串起來的任務算一群 —— A 同時開始 B、B 同時開始 C，那 A B C
   * 是同一個時間點的三路，只該有一根棒子而不是兩根。群內的方向性（誰等誰）
   * 留在聚焦面板的句子裡講，圖上不畫 —— 它們的日期本來就綁在一起。
   */
  const simul = useMemo(() => {
    const groups: Array<{ id: string; kind: 'fork' | 'join'; members: string[] }> = []
    const forkOf = new Map<string, (typeof groups)[number]>()
    const joinOf = new Map<string, (typeof groups)[number]>()

    const build = (kind: 'fork' | 'join', linkType: LinkType) => {
      const uf = new Map<string, string>()
      const find = (x: string): string => {
        let root = x
        while (uf.get(root) !== root) root = uf.get(root)!
        for (let cur = x; uf.get(cur) !== root;) {
          const nx = uf.get(cur)!
          uf.set(cur, root)
          cur = nx
        }
        return root
      }
      for (const e of schedEdges) {
        if (e.linkType !== linkType) continue
        for (const id of [e.sourceId, e.targetId]) if (!uf.has(id)) uf.set(id, id)
        const a = find(e.sourceId)
        const b = find(e.targetId)
        if (a !== b) uf.set(a, b)
      }
      const bucket = new Map<string, string[]>()
      for (const id of uf.keys()) {
        const r = find(id)
        bucket.set(r, [...(bucket.get(r) ?? []), id])
      }
      for (const [root, members] of bucket) {
        if (members.length < 2) continue
        const g = { id: `${kind}:${root}`, kind, members }
        groups.push(g)
        for (const m of members) (kind === 'fork' ? forkOf : joinOf).set(m, g)
      }
    }
    build('fork', 'SS')
    build('join', 'FF')
    return { groups, forkOf, joinOf }
  }, [schedEdges])

  /**
   * 佈局：只在節點集合或排程依賴變動時重算。
   *
   * 這個 effect 的相依刻意只有這幾項。顏色、聚焦、圖層開關都不能放進來 ——
   * setNodes 會把 position 一起蓋掉，使用者拖過的位置就沒了。上層傳進來的
   * statuses 是 `project?.statuses ?? []`，每次 render 都是新陣列，放進相依
   * 等於「父層一 render 就把版面洗掉」。所以顏色改在 styledNodes 那邊算。
   */
  const { baseNodes, layoutAbs } = useMemo(() => {
    const present = new Set(shownNodes.map(n => n.id))
    const parentOf = new Map(shownNodes.map(n => [n.id, n.parentId]))
    const refOf = new Map(shownNodes.map(n => [n.id, n.ref]))
    const L = layout(shownNodes.map(n => n.id), parentOf, refOf, schedEdges)

    const nodes: TaskNode[] = shownNodes.map(n => {
      const isBox = L.boxes.has(n.id)
      const parent = n.parentId && present.has(n.parentId) ? n.parentId : undefined
      const size = L.size.get(n.id)
      return {
        id: n.id,
        type: (isBox ? 'box' : 'task') as 'box' | 'task',
        position: L.rel.get(n.id) ?? { x: 0, y: 0 },
        // 有父框就交給 React Flow 處理座標原點與整包拖曳
        ...(parent ? { parentId: parent } : {}),
        // 框的大小是算出來的，直接告訴 React Flow，不要等它量
        ...(isBox && size
          ? {
              style: { width: size.w, height: size.h },
              measured: { width: size.w, height: size.h },
            }
          : {}),
        data: {
          ref: n.ref,
          title: n.title,
          statusKey: n.statusKey,
          color: '#94a3b8',        // 佔位，實際顏色在 styledNodes 補
          progress: n.progress ?? 0,
          inquiryState: n.inquiryState,
          isEpic: isBox,
          childCount: L.childCount.get(n.id) ?? 0,
          isMilestone: n.type === 'MILESTONE',
          dimmed: false,
          focused: false,
          kin: null,
          blockedBy: [],           // 佔位，實際內容在 styledNodes 補
          parallel: NO_PARALLEL,
        },
      }
    })

    // React Flow 要求父節點排在子節點前面，不然子節點的座標會對不上
    const depth = (id: string) => {
      let d = 0
      let cur = parentOf.get(id)
      while (cur && present.has(cur) && d < 20) { d++; cur = parentOf.get(cur) }
      return d
    }
    nodes.sort((a, b) => depth(a.id) - depth(b.id))

    return { baseNodes: nodes, layoutAbs: L.abs }
  }, [shownNodes, schedEdges])

  const nodeKey = useMemo(() => baseNodes.map(n => n.id).join(','), [baseNodes])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const moves: Record<string, { x: number; y: number }> = {}
    const dims: Record<string, { width: number; height: number }> = {}
    for (const c of changes) {
      if (c.type === 'position' && c.position) moves[c.id] = c.position
      else if (c.type === 'dimensions' && c.dimensions) dims[c.id] = c.dimensions
    }
    if (Object.keys(moves).length) {
      userAdjusted.current = true
      setDragged(d => ({ ...d, ...moves }))
    }
    // 尺寸沒真的變就不要換物件 —— 平移縮放時 ResizeObserver 會重送同樣的值，
    // 每次都 setState 會讓整張圖白白重畫
    if (Object.keys(dims).length) {
      setMeasured(m => {
        const changed = Object.entries(dims).some(
          ([id, d]) => m[id]?.width !== d.width || m[id]?.height !== d.height
        )
        return changed ? { ...m, ...dims } : m
      })
    }
  }, [])

  /**
   * 把視野拉回全景：節點集合換掉時，以及按過「重新排列」時。
   *
   * 掛載那一次由 ReactFlow 的 fitView prop 負責 —— 但那個 prop 只在初始化時
   * 生效一次，所以節點**必須在第一次 render 就存在**。這正是上面把節點改成
   * useMemo 算、不再用 useNodesState + useEffect 的原因：effect 跑在首次繪製
   * 之後，ReactFlow 掛載當下拿到的是空陣列，對著 0 個節點 fit 等於沒做，
   * 之後不會再試，畫面就永遠停在 scale(1) 的左上角。（這個 bug 追了很久。）
   *
   * 代價是節點物件每次 render 都是新的，量到的尺寸得自己收好再疊回去 ——
   * 見上面 measured 的說明，那是同一件事的另一半。
   *
   * 換了資料就把視角交還給自動佈局（userAdjusted 歸零），讓下面的
   * ResizeObserver 也能重新接手。
   */
  useEffect(() => {
    if (!nodesInitialized || !baseNodes.length) return
    if (lastFitKey.current === nodeKey && !fitPending.current) return
    lastFitKey.current = nodeKey
    fitPending.current = false
    userAdjusted.current = false
    fitView(FIT_OPTIONS)
    // relayout 只是「按過重新排列」的觸發器，effect 裡不會讀它的值 ——
    // 但少了它，按鈕設好的 fitPending 要等到下次換資料才會被消化，
    // 表現成「節點歸位了，視野卻沒跟著框回去」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesInitialized, nodeKey, baseNodes.length, fitView, relayout])

  /**
   * 畫布尺寸一變就重框，除非使用者已經自己動過視角。
   *
   * 少了這一段，初次進入會間歇性停在 scale(1) 把右邊的節點切掉：畫布是
   * lazy load 進來的，ReactFlow 初始化那一刻容器可能還沒拿到最終寬高，
   * 這種時候 fitView 算出來的結果沒有意義，而它不會自己重試。
   * 用尺寸當觸發條件比追時間點可靠，順便也把「視窗縮放」「側欄展開」
   * 這些情況一併處理掉。
   */
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (userAdjusted.current) return
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      fitView(FIT_OPTIONS)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitView])

  // ── 卡住：這張任務還不能動手，因為上游還沒到位 ────────────────
  /**
   * 「被上一個任務影響、無法處理」。判斷完全看關聯 ＋ 上游目前的狀態分類：
   *
   * - 完成後開始（FS）／阻擋（BLOCKS）／需要（REQUIRES）：上游沒**完成**就卡住
   * - 同時開始（SS）：上游連**開始**都還沒，下游自然也開不了
   * - 同時完成（FF）與開始後完成（SF）不算 —— 它們約束的是收尾的時間點，
   *   不影響「現在能不能動手」，標成卡住只會讓紅字失去意義
   *
   * 自己已經完成的任務不標（做完了就無所謂上游），也才不會整張圖都是紅的。
   */
  const statusCatKey = statuses.map(s => `${s.key}:${s.category}`).join('|')
  const categoryOf = useMemo(() => {
    const m = new Map(statuses.map(s => [s.key, s.category]))
    return (key: string | undefined) => (key ? m.get(key) : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusCatKey])

  const { blockedBy, blockerIds } = useMemo(() => {
    const out = new Map<string, string[]>()
    /** 卡住每張任務的源頭是誰（任務 id）。聚焦時要把源頭一起留亮 */
    const ids = new Map<string, string[]>()
    if (!showBlocked) return { blockedBy: out, blockerIds: ids }
    const byId = new Map(shownNodes.map(n => [n.id, n]))

    // 直接卡住：上游還沒完成，這張就開不了工。
    // 除了給人看的句子，也留著 id —— 聚焦時要把源頭一起留亮
    const direct = new Map<string, Array<{ id: string; label: string }>>()
    // 同時開始的另一端：它還沒開始，這張也開不了
    const startsWith = new Map<string, string[]>()
    for (const e of graph?.edges ?? []) {
      const src = byId.get(e.sourceId)
      const dst = byId.get(e.targetId)
      if (!src || !dst) continue
      const srcCat = categoryOf(src.statusKey)
      if (e.linkType === 'FS' || e.linkType === 'BLOCKS' || e.linkType === 'REQUIRES') {
        if (srcCat === 'DONE') continue
        direct.set(dst.id, [...(direct.get(dst.id) ?? []),
                            { id: src.id, label: `${src.ref} 完成` }])
      } else if (e.linkType === 'SS') {
        if (srcCat !== 'TODO') continue
        startsWith.set(dst.id, [...(startsWith.get(dst.id) ?? []), src.id])
      }
    }

    /**
     * 同時開始的那一端如果自己也被卡住，要往上追到真正的源頭。
     *
     * 例：MRG-5 完成後才能做 MRG-6，而 MRG-7 跟 MRG-6 同時開始。
     * 這時候在 MRG-7 上寫「要等 MRG-6 開始」是對的但沒有用 ——
     * 真正擋著的是 MRG-5，而使用者要知道的是「去推哪一張」。
     * 只有當同時開始的對方自己沒被卡住（單純還沒有人動手）時，才寫它。
     */
    const resolve = (id: string, seen: Set<string>): Array<{ id: string; label: string }> => {
      if (seen.has(id)) return []
      seen.add(id)
      const reasons = [...(direct.get(id) ?? [])]
      for (const peerId of startsWith.get(id) ?? []) {
        const upstream = resolve(peerId, seen)
        if (upstream.length) reasons.push(...upstream)
        else reasons.push({ id: peerId, label: `${byId.get(peerId)!.ref} 開始` })
      }
      return reasons
    }

    for (const n of shownNodes) {
      if (categoryOf(n.statusKey) === 'DONE') continue
      const reasons = resolve(n.id, new Set())
      if (!reasons.length) continue
      const seenLabel = new Set<string>()
      const uniq = reasons.filter(r => !seenLabel.has(r.label) && seenLabel.add(r.label))
      out.set(n.id, uniq.map(r => r.label))
      ids.set(n.id, uniq.map(r => r.id))
    }
    return { blockedBy: out, blockerIds: ids }
  }, [graph, shownNodes, categoryOf, showBlocked])

  // ── 聚焦子圖：選中的節點與它的鄰居留亮，其餘淡出 ──
  /**
   * 留亮的有三種，而且**畫法要不一樣**：
   *
   *   有關聯線的      → 這是依賴，實線外框
   *   上層／下層      → 這只是階層位置，虛線外框 ＋ 角落標「上層」「下層」
   *   卡住它的源頭    → 紅框（節點本來就會標紅），可能隔了好幾張才是真正的源頭
   *
   * 前兩種畫成一樣的話，點一張任務會看到它的大項目跟著亮，卻看不出那不是依賴 ——
   * 使用者會以為兩張任務之間有先後關係。階層仍然要留亮：不知道自己在哪一塊底下，
   * 光看依賴線也讀不懂這張圖。
   *
   * 第三種是後來補的：MRG-7 跟 MRG-6 同時開始，而 MRG-6 在等 MRG-5 ——
   * 卡住的說明上寫著 MRG-5，MRG-5 卻是暗的，「說在等它，卻看不到它」。
   */
  const { neighbours, kin } = useMemo(() => {
    if (!focusId) return { neighbours: null, kin: new Map<string, 'parent' | 'child'>() }
    const keep = new Set<string>([focusId])
    const linked = new Set<string>()
    for (const e of graph?.edges ?? []) {
      if (e.sourceId === focusId) { keep.add(e.targetId); linked.add(e.targetId) }
      if (e.targetId === focusId) { keep.add(e.sourceId); linked.add(e.sourceId) }
    }
    for (const id of blockerIds.get(focusId) ?? []) { keep.add(id); linked.add(id) }
    const k = new Map<string, 'parent' | 'child'>()
    for (const n of shownNodes) {
      if (n.parentId === focusId) { keep.add(n.id); if (!linked.has(n.id)) k.set(n.id, 'child') }
      if (n.id === focusId && n.parentId) {
        keep.add(n.parentId)
        if (!linked.has(n.parentId)) k.set(n.parentId, 'parent')
      }
    }
    return { neighbours: keep, kin: k }
  }, [focusId, graph, shownNodes, blockerIds])

  // ── 並行：這幾張可以同時派人做 ──────────────────────────────
  /**
   * 「同時並行」＝ 日期真的重疊，而且彼此之間沒有先後。分成三種講：
   *
   *   同時開始：連了「同時開始」，或同一天起跑 —— 人力要在同一天到位
   *   同時完成：連了「同時完成」，或同一天結束 —— 驗收會撞在同一天
   *   並行：只是期間重疊，開始與結束都各走各的
   *
   * 只看日期會把「A 完成後 B 開始、但兩張都跨了同一週」也算成並行，那是錯的；
   * 所以先用排程依賴算出可達性（含遞移），互相到得了的一律排除。SS/FF 不建立
   * 先後（見 layout 的說明），不放進可達性圖。父子也排除 —— 大項目的日期本來
   * 就是把小項目包起來，必然重疊，標出來沒有資訊量。
   */
  const parallelWith = useMemo(() => {
    const out = new Map<string, ParallelPeers>()
    if (!showParallel) return out

    const ids = shownNodes.map(n => n.id)
    const nextOf = new Map<string, string[]>(ids.map(id => [id, []]))
    for (const e of schedEdges) {
      if (e.linkType === 'SS' || e.linkType === 'FF') continue
      nextOf.get(e.sourceId)?.push(e.targetId)
    }
    /** id → 從它出發到得了的所有任務 */
    const reach = new Map<string, Set<string>>()
    for (const id of ids) {
      const seen = new Set<string>()
      const stack = [...(nextOf.get(id) ?? [])]
      while (stack.length) {
        const cur = stack.pop()!
        if (seen.has(cur)) continue
        seen.add(cur)
        stack.push(...(nextOf.get(cur) ?? []))
      }
      reach.set(id, seen)
    }

    const parentOf = new Map(shownNodes.map(n => [n.id, n.parentId]))
    const isKin = (a: string, b: string) => {
      for (const [from, to] of [[a, b], [b, a]] as const) {
        let cur: string | null | undefined = parentOf.get(from)
        for (let d = 0; cur && d < 20; d++) {
          if (cur === to) return true
          cur = parentOf.get(cur)
        }
      }
      return false
    }

    const span = new Map<string, { s: string; e: string }>()
    for (const t of tasks) {
      if (t.startDate && t.dueDate) span.set(t.id, { s: t.startDate, e: t.dueDate })
    }
    const refOf = new Map(shownNodes.map(n => [n.id, n.ref]))
    const add = (id: string, kind: keyof ParallelPeers, peer: string) => {
      const cur = out.get(id) ?? { sameStart: [], sameFinish: [], overlap: [] }
      cur[kind] = [...cur[kind], peer]
      out.set(id, cur)
    }

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j]
        if (isKin(a, b)) continue                          // 父子／祖孫
        const ordered = reach.get(a)!.has(b) || reach.get(b)!.has(a)   // 有先後

        // 明確連了「同時開始」「同時完成」的，不管有沒有填日期都算數 ——
        // 那是使用者親手講的，比日期可靠
        const forkA = simul.forkOf.get(a)
        const joinA = simul.joinOf.get(a)
        const sa = span.get(a), sb = span.get(b)
        const sameStart = (!!forkA && forkA === simul.forkOf.get(b))
          || (!ordered && !!sa && !!sb && sa.s === sb.s)
        const sameFinish = (!!joinA && joinA === simul.joinOf.get(b))
          || (!ordered && !!sa && !!sb && sa.e === sb.e)

        if (sameStart) { add(a, 'sameStart', refOf.get(b)!); add(b, 'sameStart', refOf.get(a)!) }
        if (sameFinish) { add(a, 'sameFinish', refOf.get(b)!); add(b, 'sameFinish', refOf.get(a)!) }
        if (sameStart || sameFinish) continue

        if (ordered || !sa || !sb) continue
        if (sa.s > sb.e || sb.s > sa.e) continue           // 日期沒重疊
        add(a, 'overlap', refOf.get(b)!)
        add(b, 'overlap', refOf.get(a)!)
      }
    }
    return out
  }, [shownNodes, schedEdges, tasks, showParallel, simul])

  // 顏色、淡出、拖曳位移與量到的尺寸都在這裡疊上去。自動佈局的結果（baseNodes）
  // 保持不變，所以狀態改色、切換聚焦都不會把使用者拖好的版面弄亂。
  const styledNodes = useMemo(
    () => baseNodes.map(n => ({
      ...n,
      position: dragged[n.id] ?? n.position,
      // 框的尺寸是我們自己算的（見 layout），量到的值不要蓋掉它 ——
      // 蓋成 undefined 的話 React Flow 會認為它還沒量好，整張圖停在 visibility:hidden
      measured: n.measured ?? measured[n.id],
      data: {
        ...n.data,
        color: statusColor(n.data.statusKey),
        dimmed: !!neighbours && !neighbours.has(n.id),
        focused: n.id === focusId,
        kin: kin.get(n.id) ?? null,
        blockedBy: blockedBy.get(n.id) ?? [],
        parallel: parallelWith.get(n.id) ?? NO_PARALLEL,
      },
    })),
    [baseNodes, dragged, measured, neighbours, kin, focusId, statusColor, blockedBy, parallelWith]
  )

  /**
   * 匯合點的位置是算出來的，不進自動佈局。
   *
   * 分岔點貼在該欄的左邊、合流點貼在右邊，高度撐滿群內第一張到最後一張任務的
   * 中心線，看起來才像一根把它們串起來的棒子。因為它跟著任務走，使用者拖動
   * 任務時棒子也會跟著移動 —— 所以這裡讀的是拖過之後的位置。
   *
   * 尺寸是我們自己決定的，直接把 measured 填好交給 React Flow，
   * 省掉「先量再顯示」那一輪（見上面 measured 的說明）。
   */
  const junctionNodes = useMemo<JunctionNode[]>(() => {
    // 匯合點沒有父框，用的是畫布座標；框裡的任務位置是相對的，要換算過。
    // 使用者拖過的位置同樣是相對的，所以只把差值疊上去。
    const pos = new Map(baseNodes.map(n => {
      const base = layoutAbs.get(n.id) ?? n.position
      const d = dragged[n.id]
      return [n.id, d
        ? { x: base.x + (d.x - n.position.x), y: base.y + (d.y - n.position.y) }
        : base]
    }))
    const heightOf = (id: string) => measured[id]?.height ?? NODE_H_FALLBACK

    return simul.groups.flatMap(g => {
      const ms = g.members.filter(m => pos.has(m))
      if (ms.length < 2) return []
      // 圓點對齊群組的垂直中點，兩邊的扇形才會對稱
      const centres = ms.map(m => pos.get(m)!.y + heightOf(m) / 2)
      const mid = (Math.min(...centres) + Math.max(...centres)) / 2
      const x = g.kind === 'fork'
        ? Math.min(...ms.map(m => pos.get(m)!.x)) - JUNCTION_GAP - JUNCTION_SIZE
        : Math.max(...ms.map(m => pos.get(m)!.x)) + NODE_W + JUNCTION_GAP

      return [{
        id: g.id,
        type: 'junction' as const,
        position: { x, y: mid - JUNCTION_SIZE / 2 },
        measured: { width: JUNCTION_SIZE, height: JUNCTION_SIZE },
        style: { width: JUNCTION_SIZE, height: JUNCTION_SIZE },
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          kind: g.kind,
          // 聚焦時，群裡沒有任何一張亮著就跟著淡出
          dimmed: !!neighbours && !ms.some(m => neighbours.has(m)),
        },
      }]
    })
  }, [simul, baseNodes, layoutAbs, dragged, measured, neighbours])

  const allNodes = useMemo<FlowNode[]>(
    () => [...styledNodes, ...junctionNodes], [styledNodes, junctionNodes]
  )

  // ── 邊 ──────────────────────────────────────────────────
  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = []
    const dim = (a: string, b: string) =>
      !!neighbours && !(neighbours.has(a) && neighbours.has(b))

    // 階層不再畫線 —— 大項目直接把底下的任務框起來（見 layout 的說明）。
    // 一條「包含」虛線得先看懂圖例才知道是什麼，框不用。

    // ── 匯合點的扇形：分岔點射向群裡每一張，群裡每一張射進合流點 ──
    for (const g of simul.groups) {
      const color = SCHEDULING_COLOR[g.kind === 'fork' ? 'SS' : 'FF']
      const faded = !!neighbours && !g.members.some(m => neighbours.has(m))
      for (const m of g.members) {
        if (!visibleIds.has(m)) continue
        out.push({
          id: `${g.id}~${m}`,
          source: g.kind === 'fork' ? g.id : m,
          target: g.kind === 'fork' ? m : g.id,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'smoothstep',
          selectable: false,
          // 這幾支箭頭不掛字：字寫在棒子上，一群有幾張就重複幾次會太吵
          style: { stroke: color, strokeWidth: 1.8, opacity: faded ? 0.15 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        })
      }
    }

    /**
     * 進出匯合點的那一支。
     *
     * 群裡的任務日期是綁在一起的，所以上游進來的線接在棒子上（而不是接在
     * 其中一張任務上）不但畫得對，講的也是實話：卡住其中一張就是卡住整群。
     * 同一個上游同時指向群裡兩張時會併成同一條線，否則會有兩條完全重疊的線。
     */
    const seen = new Set<string>()

    for (const e of graph?.edges ?? []) {
      if (!visibleIds.has(e.sourceId) || !visibleIds.has(e.targetId)) continue
      const type = e.linkType
      const scheduling = isScheduling(type)
      if (!scheduling && !showSemantic) continue
      // 同時開始／同時完成已經由匯合點畫掉了
      if (type === 'SS' || type === 'FF') continue

      let source = e.sourceId
      let target = e.targetId
      if (scheduling) {
        const fg = simul.forkOf.get(target)
        if (fg && !fg.members.includes(source)) target = fg.id
        const jg = simul.joinOf.get(source)
        if (jg && !jg.members.includes(target)) source = jg.id
      }
      const dedup = `${source}>${target}:${type}`
      if (seen.has(dedup)) continue
      seen.add(dedup)

      const color = scheduling ? SCHEDULING_COLOR[type] : SEMANTIC_COLOR
      const faded = dim(e.sourceId, e.targetId)
      const lag = e.lagDays
        ? `．間隔 ${e.lagDays > 0 ? '+' : ''}${e.lagDays} 天`
        : ''

      out.push({
        id: e.id,
        source,
        target,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'smoothstep',
        label: LINK_CHIP[e.linkType] + lag,
        labelShowBg: false,
        labelStyle: labelText(color, faded),
        style: {
          stroke: color,
          strokeWidth: scheduling ? 1.8 : 1.2,
          strokeDasharray: scheduling ? undefined : SEMANTIC_DASH,
          opacity: faded ? 0.15 : 1,
        },
        markerEnd: {
          type: scheduling ? MarkerType.ArrowClosed : MarkerType.Arrow,
          color, width: 16, height: 16,
        },
      })
    }
    return out
  }, [graph, shownNodes, visibleIds, showSemantic, neighbours, simul])

  // ── 建立 / 刪除關聯 ──────────────────────────────────────
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['graph', projectId] })
    qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    qc.invalidateQueries({ queryKey: ['schedule', projectId] })
  }

  const addLink = useMutation({
    mutationFn: (v: { source: string; target: string }) =>
      Api.addLink(v.source, { targetId: v.target, linkType: newLinkType }),
    onSuccess: () => { setError(null); invalidate() },
    // 後端擋下循環依賴／父子衝突時，把它的中文理由原封不動顯示出來
    onError: (e: unknown) => setError(
      e instanceof ApiError ? [e.title, e.detail].filter(Boolean).join('：') : '建立關聯失敗'
    ),
  })

  const delLink = useMutation({
    mutationFn: (id: string) => Api.deleteLink(id),
    onSuccess: () => { setError(null); invalidate() },
  })

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return
    addLink.mutate({ source: c.source, target: c.target })
  }, [addLink])

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    if (window.confirm(`要刪除這條關聯嗎？（${String(edge.label ?? '')}）`)) {
      delLink.mutate(edge.id)
    }
  }, [delLink])

  const focused = focusId ? shownNodes.find(n => n.id === focusId) : undefined
  const focusedLinks = useMemo(() => {
    if (!focusId) return []
    return (graph?.edges ?? [])
      .filter(e => e.sourceId === focusId || e.targetId === focusId)
      .map(e => ({
        id: e.id,
        outgoing: e.sourceId === focusId,
        linkType: e.linkType,
        other: shownNodes.find(n => n.id === (e.sourceId === focusId ? e.targetId : e.sourceId)),
      }))
  }, [focusId, graph, shownNodes])

  if (isLoading) return <Spinner label="載入關聯圖…" />
  if (!shownNodes.length) {
    return <Empty>這裡還沒有任務。到清單或看板新增之後，關聯圖就會把它們畫出來。</Empty>
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── 工具列 ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <Button variant="ghost" onClick={() => zoomIn({ duration: 150 })} aria-label="放大">＋</Button>
        <Button variant="ghost" onClick={() => zoomOut({ duration: 150 })} aria-label="縮小">－</Button>
        <Button onClick={() => fitView(FIT_OPTIONS)}>全部顯示</Button>
        <Button onClick={() => { setDragged({}); fitPending.current = true; setRelayout(n => n + 1) }}
                title="把拖亂的節點放回自動佈局的位置">重新排列</Button>
        {/* 框選本來按住 Shift 拉框就有，但沒有人看得出來。給它一顆按鈕，
            開著的時候左鍵直接拉框、右鍵平移 */}
        <Button
          onClick={() => setBoxSelect(v => !v)}
          className={boxSelect ? 'border-blue-500 bg-blue-50 text-blue-700' : undefined}
          title={boxSelect
            ? '框選中：左鍵拉出範圍選取多張任務，選好之後拖曳就會一起移動。用右鍵或滾輪平移畫面'
            : '框選：左鍵拉出範圍選取多張任務，一起拖曳。（也可以隨時按住 Shift 拉框）'}>
          {boxSelect ? '✓ 框選' : '框選'}
        </Button>

        <div className="ml-3 flex items-center gap-3 text-sm">
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
            <input type="checkbox" checked={showSemantic}
                   onChange={e => setShowSemantic(e.target.checked)}
                   className="rounded border-slate-300" />
            語意關聯（旁邊）
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
            <input type="checkbox" checked={showBlocked}
                   onChange={e => setShowBlocked(e.target.checked)}
                   className="rounded border-slate-300" />
            🚧 卡住
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
            <input type="checkbox" checked={showParallel}
                   onChange={e => setShowParallel(e.target.checked)}
                   className="rounded border-slate-300" />
            ⇉ 並行
          </label>
        </div>

        <label className="ml-3 flex items-center gap-1.5 text-sm text-slate-600">
          拉線建立
          <select value={newLinkType} onChange={e => setNewLinkType(e.target.value as LinkType)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            <optgroup label="排程（會推動日期）">
              {SCHEDULING.map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
            </optgroup>
            <optgroup label="語意（不影響排程）">
              {(['RELATES', 'BLOCKS', 'DUPLICATES', 'REQUIRES'] as LinkType[])
                .map(t => <option key={t} value={t}>{LINK_LABEL[t]}</option>)}
            </optgroup>
          </select>
        </label>

        {/* 說明整包收在畫布左下角的「線條說明」裡，工具列不佔位 */}
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      <div ref={wrapperRef} className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={allNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          // 匯合點不是任務，點它不該聚焦、雙擊也開不出東西
          onNodeClick={(_, n) => {
            if (n.type !== 'task') return
            setFocusId(id => (id === n.id ? null : n.id))
          }}
          onNodeDoubleClick={(_, n) => { if (n.type === 'task') onOpen(n.id) }}
          onPaneClick={() => setFocusId(null)}
          // event 為 null 代表是程式呼叫的（fitView 自己），只有真人拖曳縮放才算
          onMoveStart={(e) => { if (e) userAdjusted.current = true }}
          nodesConnectable
          elevateEdgesOnSelect
          /*
           * 預設只要 1px 就算拖曳，點一下節點常常會夾帶一兩個 px 的位移，
           * 被 onNodesChange 收進 dragged 之後，那張任務就永遠偏離它那一欄
           * 一兩個 px —— 畫面上看起來就是「同一欄卻沒對齊」。拉高門檻，
           * 真的要拖才算拖。
           */
          nodeDragThreshold={4}
          /*
           * 框選：開著時左鍵拉框、右鍵（與中鍵）平移；關著時左鍵平移，
           * 按住 Shift 一樣拉得出框。選起來的節點拖一張就一起動 ——
           * onNodesChange 本來就會收到每一個被移動節點的 position。
           */
          selectionOnDrag={boxSelect}
          panOnDrag={boxSelect ? [1, 2] : true}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Control', 'Meta']}
          minZoom={0.15}
          maxZoom={2}
          fitView
          fitViewOptions={FIT_OPTIONS}
          className="bg-slate-50"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5e1" />


          {/* ── 聚焦面板 ── */}
          {focused && (
            <Panel position="top-right">
              <div className="w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[10px] text-slate-500">{focused.ref}</div>
                    <div className="text-sm font-medium text-slate-800">{focused.title}</div>
                  </div>
                  <button onClick={() => setFocusId(null)}
                          className="text-slate-400 hover:text-slate-600" aria-label="取消聚焦">✕</button>
                </div>

                {(blockedBy.get(focused.id)?.length ?? 0) > 0 && (
                  <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                    🚧 現在動不了：要等 {blockedBy.get(focused.id)!.join('、')}
                  </div>
                )}
                {(parallelWith.get(focused.id)?.sameStart.length ?? 0) > 0 && (
                  <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                    ⇉ 同一天開始：{parallelWith.get(focused.id)!.sameStart.join('、')}
                  </div>
                )}
                {(parallelWith.get(focused.id)?.sameFinish.length ?? 0) > 0 && (
                  <div className="mt-2 rounded bg-purple-50 px-2 py-1 text-xs text-purple-700">
                    ⇥ 同一天完成：{parallelWith.get(focused.id)!.sameFinish.join('、')}
                  </div>
                )}
                {(parallelWith.get(focused.id)?.overlap.length ?? 0) > 0 && (
                  <div className="mt-2 rounded bg-teal-50 px-2 py-1 text-xs text-teal-700">
                    ⇉ 可以同時做：{parallelWith.get(focused.id)!.overlap.join('、')}
                  </div>
                )}

                <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {focusedLinks.length === 0 && (
                    <p className="text-xs text-slate-400">這張任務還沒有左右關聯。</p>
                  )}
                  {focusedLinks.map(l => (
                    <div key={l.id + String(l.outgoing)} className="text-xs text-slate-600">
                      {sentence(l.linkType, l.outgoing, l.other?.ref ?? '（其他專案的任務）')}
                      {l.other && <span className="ml-1 text-slate-400">{l.other.title}</span>}
                    </div>
                  ))}
                </div>

                <Button variant="primary" className="mt-3 w-full justify-center"
                        onClick={() => onOpen(focused.id)}>開啟任務</Button>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      <LegendBar />
    </div>
  )
}

/**
 * 說明列 —— 固定在畫面最下面，兩排：線的意思在上，節點上的圖示在下。
 *
 * 原本線的說明是左下角一個會展開的浮層，展開後蓋掉半張圖，還要特地回去關。
 * 改成常駐在圖的下面：它跟圖不重疊，看一眼就走，不用開關。
 *
 * 每一項的完整說法掛在 title 上（游標停著就會出現），列上只留短標籤 ——
 * 一排放得下的字數有限，而且大部分時候使用者只是要確認「這條線是哪一種」。
 */
function LegendBar() {
  /**
   * 點開的那一則說明。
   *
   * 每一項的說明本來只掛在 `title` 上，游標要停著不動一秒才會出現，
   * 而且在觸控螢幕上根本叫不出來。點一下就在那一項的正上方跳出同一段文字，
   * 長相跟系統的提示框一樣（深色小方框），再點一次或點別的地方收起來。
   * 刻意不做成橫跨整列的長條 —— 那看起來像另一塊面板，不像「這一項的說明」。
   */
  const [tip, setTip] = useState<
    { label: string; text: string; x: number; pinned: boolean } | null
  >(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!tip) return
    const close = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as globalThis.Node)) setTip(null)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setTip(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    // 點開的說明看完就該自己消失 —— 沒有人想為了看一句話再回去按一次關閉。
    // 滑過去顯示的那種本來就會在移開時收掉，不用計時。
    const timer = tip.pinned ? window.setTimeout(() => setTip(null), 6000) : undefined
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
      if (timer) window.clearTimeout(timer)
    }
  }, [tip])

  /**
   * 提示框對齊被指到的那一項，所以要記下它在列上的水平位置。
   *
   * 滑過去就顯示、移開就收；點一下則「釘住」，移開也不收，
   * 要再點一次或點別的地方才關。同一個框兩種用法，不用瀏覽器原生的 title ——
   * 原生的要停住不動一秒才出現，而且觸控螢幕根本叫不出來。
   */
  const at = (e: ReactMouseEvent<HTMLElement>) => {
    const bar = barRef.current?.getBoundingClientRect()
    const item = e.currentTarget.getBoundingClientRect()
    return bar ? item.left + item.width / 2 - bar.left : 0
  }
  const hover = (label: string, text: string) => (e: ReactMouseEvent<HTMLElement>) => {
    // 位置一定要在呼叫 setTip 之前算好。放進 updater 裡的話 React 可能晚一點才執行它，
    // 那時 event.currentTarget 已經被清成 null，整個元件就炸了。
    const x = at(e)
    setTip(t => (t?.pinned ? t : { label, text, x, pinned: false }))
  }
  const unhover = () => setTip(t => (t?.pinned ? t : null))
  const show = (label: string, text: string) => (e: ReactMouseEvent<HTMLElement>) => {
    const x = at(e)
    setTip(t => (t?.pinned && t.label === label ? null : { label, text, x, pinned: true }))
  }

  return (
    <div ref={barRef}
         className="relative flex items-stretch border-t border-slate-200 bg-white
                    text-[11px] text-slate-500">
      {tip && (
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-1 w-max max-w-sm
                     -translate-x-1/2 rounded-md bg-slate-800 px-2.5 py-1.5 text-[11px]
                     leading-5 text-white shadow-lg"
          /* 貼齊左右邊界：靠最左或最右的項目，置中之後會有一半跑到列外面 */
          style={{ left: `clamp(0.5rem, ${tip.x}px, calc(100% - 0.5rem))` }}
          role="tooltip">
          <div className="font-medium text-white">
            {tip.label}
            {tip.pinned && <span className="ml-2 text-[10px] text-slate-400">會自動關閉</span>}
          </div>
          <div className="whitespace-pre-wrap text-slate-200">{tip.text}</div>
        </div>
      )}
      {/* 「操作說明」自成最左邊一格、跨兩排 —— 擠在「線」那一排的開頭會讀成
          「線 說明」，看起來像在說明線的一種。
          裡面只放「怎麼操作」，線與圖示各自的意思在右邊那兩排上滑過去就有。 */}
      <div className="flex shrink-0 items-center border-r border-slate-200 px-3">
        <span
          className="cursor-help rounded bg-slate-100 px-2 py-1 font-medium text-slate-600
                     hover:bg-slate-200"
          onMouseEnter={hover('怎麼操作', OPERATION_HELP)}
          onMouseLeave={unhover}
          onClick={show('怎麼操作', OPERATION_HELP)}>操作說明</span>
      </div>

      {/* 兩排都可以左右滑：圖示只會愈加愈多，硬要塞進一排就會折行把圖擠掉 */}
      <div className="min-w-0 flex-1">
      <LegendRowStrip label="線">
        {SCHEDULING.map(t => (
          <LegendLine key={t} color={SCHEDULING_COLOR[t]} label={LINK_CHIP[t]}
                      onMouseEnter={hover(LINK_CHIP[t], SCHEDULING_HELP[t])}
                      onMouseLeave={unhover}
                      onClick={show(LINK_CHIP[t], SCHEDULING_HELP[t])} />
        ))}
        <LegendLine color={SEMANTIC_COLOR} dash={SEMANTIC_DASH} label="語意關聯"
                    onMouseEnter={hover('語意關聯', SEMANTIC_HELP)}
                    onMouseLeave={unhover}
                    onClick={show('語意關聯', SEMANTIC_HELP)} />
        {/* 階層沒有線可以說明 —— 大項目直接把底下的任務框起來 */}
        <button type="button"
                onMouseEnter={hover('大項目的框', BOX_HELP)} onMouseLeave={unhover}
                onClick={show('大項目的框', BOX_HELP)}
                className="flex shrink-0 cursor-help items-center gap-1.5 hover:text-slate-800">
          <span className="inline-block h-3 w-5 rounded-sm border border-violet-400 bg-violet-50" />
          大項目的框
        </button>
        <button type="button"
                onMouseEnter={hover('匯合點', JUNCTION_HELP)} onMouseLeave={unhover}
                onClick={show('匯合點', JUNCTION_HELP)}
                className="flex shrink-0 cursor-help items-center gap-1 hover:text-slate-800">
          <span className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: SCHEDULING_COLOR.SS }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: SCHEDULING_COLOR.FF }} />
          匯合點
        </button>
      </LegendRowStrip>

      <LegendRowStrip label="圖示">
        {ICON_HELP.map(h => (
          <LegendChip key={h.label} className={h.className}
                      onMouseEnter={hover(h.label, h.text)} onMouseLeave={unhover}
                      onClick={show(h.label, h.text)}>
            {h.label}
          </LegendChip>
        ))}
        {(['AWAITING', 'OVERDUE', 'PARTIAL', 'REPLIED'] as const).map(st => (
          <LegendChip key={st}
                      onMouseEnter={hover(INQUIRY_META[st].label, INQUIRY_HELP[st])}
                      onMouseLeave={unhover}
                      onClick={show(INQUIRY_META[st].label, INQUIRY_HELP[st])}>
            {INQUIRY_META[st].icon} {INQUIRY_META[st].label}
          </LegendChip>
        ))}
      </LegendRowStrip>
      </div>
    </div>
  )
}

/** 一排說明。左邊固定一個小標，右邊的內容超出寬度就左右滑，不折行 */
function LegendRowStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1">
      <span className="shrink-0 font-medium text-slate-600">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-x-4 overflow-x-auto
                      whitespace-nowrap [scrollbar-width:thin]">
        {children}
      </div>
    </div>
  )
}

/**
 * 說明列上的一項。
 *
 * 刻意不用瀏覽器原生的 `title` —— 它要停住不動一秒才出現、樣子不能控制、
 * 觸控螢幕也叫不出來。滑過去與點一下都走自己畫的那個提示框。
 */
type LegendItemProps = {
  onClick?: MouseEventHandler<HTMLButtonElement>
  onMouseEnter?: MouseEventHandler<HTMLButtonElement>
  onMouseLeave?: () => void
}

function LegendChip({ className, children, ...h }: LegendItemProps & {
  className?: string; children: ReactNode
}) {
  return (
    <button type="button" {...h}
            className={cx('shrink-0 cursor-help hover:text-slate-800', className)}>
      {children}
    </button>
  )
}

function LegendLine({ color, label, dash, ...h }: LegendItemProps & {
  color: string; label: string; dash?: string
}) {
  return (
    <button type="button" {...h}
            className="flex shrink-0 cursor-help items-center gap-1.5 hover:text-slate-800">
      {/* 用 svg 而不是 border-style，才能跟畫面上的線用同一組 strokeDasharray */}
      <svg width="20" height="2" className="shrink-0" aria-hidden>
        <line x1="0" y1="1" x2="20" y2="1"
              stroke={color} strokeWidth="2" strokeDasharray={dash} />
      </svg>
      {label}
    </button>
  )
}

/**
 * 把一條關聯講成一句完整的話，而且分方向講。
 * 同一條「完成後開始」站在上游和下游看到的意思相反 —— 這是最容易看錯的地方。
 * 與任務詳情頁的說法保持一致。
 */
function sentence(type: LinkType, outgoing: boolean, ref: string): string {
  switch (type) {
    case 'FS': return outgoing ? `${ref} 要等我完成，才能開始` : `要等 ${ref} 完成，我才能開始`
    case 'SS': return outgoing ? `${ref} 要等我開始，才能開始` : `要等 ${ref} 開始，我才能開始`
    case 'FF': return outgoing ? `${ref} 要等我完成，才能完成` : `要等 ${ref} 完成，我才能完成`
    case 'SF': return outgoing ? `${ref} 要等我開始，才能完成` : `要等 ${ref} 開始，我才能完成`
    case 'RELATES': return `與 ${ref} 相關`
    case 'BLOCKS': return outgoing ? `阻擋 ${ref}` : `被 ${ref} 阻擋`
    case 'DUPLICATES': return outgoing ? `重複於 ${ref}` : `被 ${ref} 重複`
    case 'REQUIRES': return outgoing ? `需要 ${ref}` : `被 ${ref} 需要`
  }
}
