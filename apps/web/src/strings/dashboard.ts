/** 儀表板（燃盡圖、負載熱圖）用到的文字。寫法見 strings/index.ts */
export const dashboard = {
  title: '儀表板',
  loading: '計算中…',

  /** 兩張圖共用的一排控制項 */
  controls: {
    /**
     * 算「幾張任務」還是「幾個工時」。兩張圖一起換 ——
     * 同一個畫面上兩張圖用不同單位，看的人一定會把它們讀成同一件事。
     */
    metric: '計算單位',
    metricCount: '任務張數',
    metricHours: '預估工時',
    range: '看哪一段',
    from: '從',
    to: '到',
    /** 熱圖的快速區間 */
    rangeTwoWeeks: '兩週',
    rangeFourWeeks: '四週',
    rangeEightWeeks: '八週',
    /** 回到系統自己算出來的預設區間 */
    reset: '回到預設區間',
  },

  /** 數值後面的單位。中文的量詞跟著東西走，不能共用一個 */
  unit: {
    count: (n: number) => `${n} 張`,
    hours: (n: number) => `${n} 小時`,
  },

  burndown: {
    title: '燃盡圖',
    subtitle: '還沒做完的量，一天一個點',

    /** 三條線的名字。理想線是參考線不是資料，所以畫成虛線 */
    legend: {
      remaining: '實際還沒做完',
      total: '總量（含中途加進來的）',
      ideal: '照計畫應該剩下',
    },

    /**
     * 圖底下那行提醒。**這句一定要留著** —— 燃盡圖是回推出來的，
     * 看的人有權知道哪幾張是猜的，不然他會拿估出來的線去跟人吵架。
     */
    estimatedNote: (n: number) =>
      `其中 ${n} 張任務在活動紀錄裡查不到當初改狀態的那一筆，` +
      `完成時間是拿「最後更新時間」估的。往後改的狀態都會留下紀錄，這個數字會自己變少。`,
    noHistoryTitle: '這個專案還沒有可以回推的歷史。',
    noHistoryHint:
      '燃盡圖是拿活動紀錄一天一天重播出來的。任務的狀態被改過幾次之後，這裡就會有線。',
    emptyTitle: '這個區間裡沒有任務。',
    emptyHint: '換一段日期，或先到清單新增任務。',

    /** 圖上方的三個數字 */
    stat: {
      remaining: '現在還沒做完',
      ideal: '照計畫應該剩下',
      /** 落後就是正的，超前是負的；兩種說法不一樣，不要共用一句 */
      behind: (n: string) => `落後 ${n}`,
      ahead: (n: string) => `超前 ${n}`,
      onTrack: '跟計畫一致',
      done: '已完成',
    },

    /** 座標軸 */
    axis: {
      remainingCount: '還沒做完（張）',
      remainingHours: '還沒做完（小時）',
    },

    /** 滑過去顯示的那一小塊 */
    tooltip: {
      remaining: '實際還沒做完',
      ideal: '照計畫應該剩下',
      total: '總量',
      done: '當天累計完成',
      future: '這天還沒到',
    },
  },

  workload: {
    title: '負載熱圖',
    subtitle: '每個人每天身上壓著多少事',

    /** 沒有指定負責人的任務也要看得到，不然那些事會整批消失在圖外 */
    unassigned: '沒有指定負責人',
    /** 一整列的總計 */
    rowTotal: '合計',
    peak: '最高一天',

    emptyTitle: '這個區間裡沒有排定日期的任務。',
    emptyHint: '任務要有開始日與完成日才排得進熱圖 —— 沒有日期的排不到哪一天上。',

    /** 色階的說明 */
    legend: {
      title: '每天的量',
      none: '沒有',
      light: '少',
      heavy: '多',
      over: '超過負荷',
      leave: '請假',
    },

    /**
     * 每一格滑過去的說明。人名與日期在外面組，這裡只講量 ——
     * 中文的語序跟英文不一樣，拼起來的句子搬不動（見 strings/index.ts）
     */
    cell: {
      empty: '沒有事情落在這一天',
      tasks: (n: number) => `${n} 張任務`,
      hours: (h: string) => `${h} 小時`,
      over: (h: string) => `超過每日負荷 ${h}`,
      onLeave: '這天請假',
      /** 請假那天還壓著事情 —— 熱圖最值得看的就是這種格子 */
      onLeaveBusy: '這天請假，但還有事情排在他身上',
    },

    /**
     * 「每日負荷」是拿來判斷紅字的門檻，不是規定誰要做幾小時。
     * 講成「上限」會被讀成公司政策，所以講「當作滿載的量」。
     */
    capacity: (v: string) => `每人每天超過 ${v} 就算超載`,
    /** 工時攤法要講清楚，不然數字對不起來的時候沒人知道怎麼算的 */
    spreadNote:
      '工時是拿任務的預估時數，平均攤在它的工作日上；沒填時數的任務一律算成一張，不進工時。',
  },

  /** 兩張圖共用：看不到就給表格，色盲與螢幕閱讀器靠它 */
  tableView: {
    show: '改看表格',
    hide: '改看圖',
    date: '日期',
    person: '負責人',
  },
} as const
