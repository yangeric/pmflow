/**
 * 週檢視用到的文字。寫法見 strings/index.ts。
 *
 * 這個畫面要回答的問題只有一個：「這一週有哪些任務在跑、各卡在哪個狀態」。
 * 所以文案一律講「這一週」而不是「本期間」，也不出現任何英文縮寫。
 */
export const week = {
  /** 工具列 */
  prevWeek: '上一週',
  thisWeek: '這一週',
  nextWeek: '下一週',
  /** 標題那一段日期，例如「8/4 – 8/10」 */
  rangeLabel: (start: string, end: string) => `${start} – ${end}`,
  /** 日期底下那一行年份。跨年的那一週要把兩個年份都講出來 */
  yearLabel: (year: number) => `${year} 年`,
  yearSpanLabel: (from: number, to: number) => `${from} 年 – ${to} 年`,
  /** 目前看的正好是今天所在的那一週時，標題旁邊掛一個標記 */
  currentBadge: '現在這一週',
  /** 工具列右側的總計 */
  summary: (n: number) => `這一週共有 ${n} 張任務在進行`,

  /** 欄位標題 */
  colTask: '任務',
  colAssignee: '負責人',
  colDates: '起訖日',
  colProgress: '進度',
  colInquiry: '對外詢問',

  /** 狀態分組的標題：狀態名稱後面接張數 */
  groupCount: (n: number) => `${n} 張`,
  /** 任務指到一個這個專案已經沒有的狀態／類型時，收在最後一組 */
  unknownStatus: '未對應的狀態',
  unknownType: '未對應的類型',

  /**
   * 分組方式。依狀態回答「這禮拜卡在哪一關」，
   * 依類型回答「這禮拜是在做事，還是在處理問題」—— 一週裡問題佔了半數的話，
   * 那件事光看狀態分組是看不出來的。
   */
  groupByLabel: '分組方式',
  groupByStatus: '依狀態',
  groupByType: '依類型',

  /**
   * 分組收合。狀態一多，畫面就變成一長條要一直捲；
   * 把不關心的那幾段收起來，剩下的才看得到彼此。
   */
  collapseGroup: (name: string) => `收合${name}`,
  expandGroup: (name: string) => `展開${name}`,
  collapseAll: '全部收合',
  expandAll: '全部展開',
  /**
   * 收起來的那一組，逾期張數要留在標題上 ——
   * 收合是「我現在不看細節」，不是「這些事可以不管」。
   */
  groupOverdue: (n: number) => `${n} 張已逾期`,

  /** 負責人還沒指定 */
  unassigned: '未指派',

  /** 起訖日的三種寫法 —— 只填一邊也要看得出來是哪一邊沒填 */
  bothDates: (start: string, end: string) => `${start} – ${end}`,
  startOnly: (start: string) => `${start} 開始，還沒填到期日`,
  dueOnly: (due: string) => `到 ${due} 為止，還沒填開始日`,

  /** 這張任務不是這一週才開始、或不是這一週結束，講清楚它的來龍去脈 */
  fromBefore: '接續上一週',
  toAfter: '延續到下一週',
  wholeWeek: '整週都在進行',

  /** 到期日已經過了而且還沒完成 */
  overdueTip: '已經過了到期日，狀態還沒進到完成。',

  /** 進度是任務自己填的數字，不是從子任務推算的 */
  progressLabel: (n: number) => `${n}%`,

  /** 這一週完全沒有任務時要講一句話，不要留一片空白 */
  emptyWeek: '這一週沒有任務在進行。可以切到上一週或下一週看看，或到清單、看板幫任務填上開始日與到期日。',

  /** 沒有排期的任務不進這個畫面，但要講一聲，不然會以為任務不見了 */
  undated: (n: number) =>
    `另有 ${n} 張沒有排期的任務（開始日與到期日都沒填，不屬於任何一週）。`,

  /** 游標停著看的完整說明 */
  rowTooltip: (ref: string, title: string) => `${ref} ${title}｜點一下打開任務詳情`,
} as const
