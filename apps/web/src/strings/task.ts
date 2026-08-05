/** 任務：清單、看板、詳情、關聯用到的文字。寫法見 strings/index.ts */
export const task = {
  problem: {
    label: '目前遇到的問題',
    badge: '有問題',
    tooltip: (text: string) => `目前遇到的問題：${text}`,
    clear: '已解決，清空',
    placeholder: '現在卡在哪裡？例如：等對方確認規格、測試機還沒到、預算還沒下來',
    /** 清空之後字會進活動紀錄，這句是唯一告知的地方，不要縮短 */
    hint: '寫了之後，清單、看板、關聯圖上都會標一個「有問題」。'
      + '解決了就按「已解決，清空」—— 寫過的內容會留在下面的活動紀錄裡。',
  },

  /**
   * 任務類型與優先級：資料庫存的是列舉值，畫面上要中文。
   * 放這裡是因為詳情、清單、看板各自都要顯示同一組字，
   * 以前三個檔各抄一份，改了其中一個就對不齊。
   */
  type: {
    EPIC: '大項目',
    MILESTONE: '里程碑',
    BUG: '缺陷',
  },
  priority: {
    LOW: '低',
    NORMAL: '普通',
    HIGH: '高',
    URGENT: '緊急',
  },

  /** 任務詳情（右側主區／抽屜） */
  drawer: {
    fieldStatus: '狀態',
    fieldPriority: '優先級',
    fieldStart: '開始日',
    fieldDue: '結束日',
    fieldProgress: '進度 %',
    fieldScheduleMode: '排程模式',
    scheduleAuto: '自動（依關聯推算日期）',
    scheduleManual: '人工鎖定（日期固定不被推動）',
    activityTitle: '活動紀錄',
    /** 沒有操作者的紀錄是系統自己寫的（例如排程推算） */
    systemActor: '系統',
  },

  /** 左右關聯（依賴與語意） */
  link: {
    title: '任務關聯',
    titleHint: '（左右：依賴與語意）',
    empty: '還沒有任何關聯。',
    lagDays: (days: number) => `間隔 ${days > 0 ? '+' : ''}${days} 天`,
    fieldTarget: '關聯到',
    fieldType: '關聯類型',
    fieldLag: '間隔（天）',
    pickTask: '選擇任務…',
    groupScheduling: '排程（會推動日期）',
    groupSemantic: '語意（不影響排程）',
    lagHint: '正數＝中間要空幾天；負數＝可以提前重疊',
    add: '建立關聯',
    /** 後端沒給訊息時才用這句，有訊息一律照後端的 */
    addFailed: '建立關聯失敗',
  },

  /** 上下階層 */
  children: {
    title: '子任務',
    titleHint: '（上下：階層）',
  },

  /** 活動紀錄的每一行 */
  activity: {
    created: '建立了這張任務',
    comment: (text: string) => `留言：${text}`,
    linkChange: (label: string) => `調整關聯（${label}）`,
    inquiryAsk: (unit: string) => `發文給 ${unit}`,
    inquiryReply: (unit: string) => `登錄回覆${unit ? `（${unit}）` : ''}`,
    problemSet: (text: string) => `記下目前遇到的問題：${text}`,
    problemCleared: (before: string) => `把問題標為已解決${before ? `（原本：${before}）` : ''}`,
    fieldUpdated: '更新了欄位',
  },

  /** 清單／樹狀視圖 */
  list: {
    colTask: '任務',
    colAssignee: '負責人',
    colStatus: '狀態',
    colInquiry: '發文追蹤',
    colStart: '開始',
    colDue: '結束',
    colProgress: '進度',
    addChild: '＋ 子任務',
    addChildTip: (title: string) => `在「${title}」底下新增子任務`,
    addChildPlaceholder: (title: string) => `在「${title}」底下新增，按 Enter 建立`,
    addTask: '＋ 新增任務',
    addTaskPlaceholder: '輸入標題後按 Enter 新增任務',
    keepOpenHint: '建立後輸入框會留著，可以連續加好幾張',
    overdueTip: '已過結束日且尚未完成',
    derivedProgressTip: (total: number, done: number) =>
      `由 ${total} 個子任務加權平均算出（已完成 ${done} 個）`,
  },

  /** 看板 */
  board: {
    overdueCount: (count: number) => `${count} 逾期`,
    dropHere: '拖曳卡片到這裡',
  },

  /**
   * 權限說明。後端的規則寫在 apps/api/src/routes/tasks.ts 的 assertCanEditTask：
   * 任務的內容只有開這張任務的人與專案管理者改得動，
   * 但「目前遇到的問題」與登錄發文追蹤的回覆是每個專案成員都能做的。
   *
   * 沒權限的控制項一律不畫（不是畫出來再灰掉），所以這裡的句子是用來
   * 回答「為什麼這裡只剩文字」—— 少了這一句，畫面看起來只是壞掉。
   */
  permission: {
    readOnlyTitle: '這張任務你只能看，不能修改內容',
    readOnlyWhy: '任務的內容只有開這張任務的人與專案管理者可以修改。'
      + '你仍然可以填寫「目前遇到的問題」，也可以登錄發文追蹤的回覆。',
    /** 清單上的狀態變成純文字時，游標停著看得到原因 */
    cannotChangeStatus: '狀態只有開這張任務的人與專案管理者可以調整',
    /** 看板上不能拖的卡片 */
    cannotDragCard: '這張任務不是你開的，不能拖動；'
      + '狀態要由開這張任務的人或專案管理者調整',
    /** 建立關聯兩端都要編輯權限，跟「誰開的」無關（見 api 的 routes/links.ts） */
    linkReadOnly: '建立與移除任務關聯需要專案編輯者以上的權限。',
  },
} as const
