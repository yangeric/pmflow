/** 導覽、頁籤、標題列 用到的文字。寫法見 strings/index.ts */
export const nav = {
  appName: 'PMFlow',
  starting: '啟動中…',

  /** 蓋在最上面那一層（帳號設定／系統管理）的頁籤 */
  accountSettings: '帳號設定',
  systemAdmin: '系統管理',

  /** 麵包屑與返回。箭頭留在畫面上，這裡只放字 */
  backToOverview: '回總覽',
  /** 任務還沒載到名字時的替代標題 */
  fallbackTaskTitle: '任務',
  showAll: '看全部',
  overdueHere: (n: number) => `${n} 張任務的對外詢問逾期`,

  /**
   * 成員的入口在右上角的頭像選單裡，只有人在專案裡的時候才畫。
   * 那個選單其他項目講的都是「我這個人」，所以這裡要講清楚是「這個專案的」。
   */
  members: '專案成員',
  pendingJoinsHint: (n: number) => `${n} 件加入申請等你核准`,

  views: {
    list: '清單',
    board: '看板',
    calendar: '行事曆',
    /** 這一週有哪些任務在跑、各卡在哪個狀態 */
    week: '週檢視',
    gantt: '甘特圖',
    graph: '關聯圖',
    /** 燃盡圖與負載熱圖。看的是整個專案的走勢，不是單張任務 */
    dashboard: '儀表板',
    /** 對外詢問是專案裡的一個頁籤，只看得到這個專案的 */
    inquiry: '對外詢問',
  },
  loadingGantt: '載入甘特圖…',
  loadingGraph: '載入關聯圖…',
  loadingDashboard: '載入儀表板…',

  sidebar: {
    switchProject: '切換專案',
    epics: '大項目',
    epicsHint: '點大項目看總覽，點小項目在右邊開詳情',
    allTasks: '全部任務',
    emptyTitle: '還沒有大項目。',
    emptyHint: '大項目就是把一件大事分成幾塊，例如「機房搬遷」底下掛盤點、採購、搬運。',
    /** 大項目樹上的展開／收合箭頭 */
    expandEpic: '展開',
    collapseEpic: '收合',
    epicSummary: (title: string, done: number, total: number) =>
      `${title}　${done}/${total} 個小項目已完成`,
    epicOverdue: (n: number) => `底下有 ${n} 張任務的對外詢問逾期`,
    taskOverdue: '這一支底下的對外詢問逾期（含自己）',

    /**
     * 底下掛著幾張問題。
     *
     * 徽章上只寫數字看不出來是什麼（旁邊還有一個逾期的數字），
     * 所以帶一個「問」字；完整的說法留給游標停著時的提示。
     * 算的是**整棵子樹**、而且**不含自己** —— 收著的大項目看到的是總數，
     * 展開之後每張任務再各自顯示自己底下的，兩個數字才對得起來。
     */
    bugBadge: (n: number) => `問 ${n}`,
    /**
     * 逾期的徽章跟問題的徽章排在一起，只寫數字的話兩個數字分不出誰是誰，
     * 所以同樣帶一個字。任務那一列沒有數字（一張任務就是逾或不逾），只寫「逾」。
     */
    overdueBadge: (n: number) => `逾 ${n}`,
    epicBugs: (n: number) => `底下有 ${n} 張問題`,
    taskBugs: (n: number) => `這一支底下有 ${n} 張問題（含自己）`,
    /** 它自己就是一張問題、底下也沒有別的 —— 「底下有 1 張」會讓人去找那一張 */
    taskIsBug: '這張本身就是問題',
    taskTitle: (ref: string, title: string) => `${ref}　${title}`,
    loose: (n: number) => `另有 ${n} 個任務的上層已被刪除，在「全部任務」裡找得到`,
    epicNamePlaceholder: '大項目名稱',
    addEpic: '新增大項目',
    /** 側欄整體的收折 */
    collapseSidebar: '收合側欄',
    expandSidebar: '展開側欄',
  },

  notification: {
    title: '通知',
    unreadAria: (n: number) => `通知，${n} 則未讀`,
    markAllRead: '全部標為已讀',
    emptyTitle: '目前沒有通知。',
    emptyHint: '任務被指向、被指派，或有人申請加入你開的專案時會出現在這裡。',
    role: {
      MANAGER: '管理者', EDITOR: '編輯者', COMMENTER: '可留言', VIEWER: '唯讀',
    },
    /** 通知句子裡的代稱：資料缺一角時頂上去，句子才不會斷掉 */
    someone: '有人',
    someTask: '一張你負責的任務',
    yourProject: '你開的專案',
    otherTask: '另一張任務',
    yourTask: '你的任務',
    quoted: (s: string) => `「${s}」`,
    /** 一句話講完發生什麼事，主詞是做這件事的人 */
    linkedTo: (who: string, other: string, task: string) => `${who} 把${other}關聯到你的${task}`,
    linkedPlain: (who: string, task: string) => `${who} 建立了一條關聯到你的${task}`,
    assigned: (who: string, task: string) => `${who} 把${task}指派給你`,
    joinRequested: (who: string, project: string) => `${who} 申請加入${project}`,
    joinAdded: (who: string, project: string) => `${who} 把你加入${project}`,
    joinApproved: (who: string, project: string) => `${who} 核准了你加入${project}的申請`,
    roleIs: (role: string) => `你的身分是${role}`,
    /**
     * 被指向這一端看到的完整句子。兩張任務都寫名字、一個代名詞都不留 ——
     * 通知是在別的地方看到的，「我」會被讀成收通知的人。
     */
    link: {
      FS: (mine: string, other: string) => `你的${mine}要等 ${other} 完成才能開始`,
      SS: (mine: string, other: string) => `你的${mine}要等 ${other} 開始才能開始`,
      FF: (mine: string, other: string) => `你的${mine}要等 ${other} 完成才能完成`,
      SF: (mine: string, other: string) => `你的${mine}要等 ${other} 開始才能完成`,
      RELATES: (mine: string, other: string) => `${other} 與你的${mine}相關`,
      BLOCKS: (mine: string, other: string) => `${other} 阻擋你的${mine}`,
      DUPLICATES: (mine: string, other: string) => `${other} 被標記為與你的${mine}重複`,
      REQUIRES: (mine: string, other: string) => `${other} 需要你的${mine}`,
    },
    time: {
      justNow: '剛剛',
      minutes: (n: number) => `${n} 分鐘前`,
      hours: (n: number) => `${n} 小時前`,
      days: (n: number) => `${n} 天前`,
    },
  },

  login: {
    subtitleLogin: '登入你的工作區',
    subtitleRegister: '建立新帳號',
    displayName: '顯示名稱',
    displayNamePlaceholder: '王小明',
    email: '電子郵件',
    password: '密碼',
    submitting: '處理中…',
    login: '登入',
    register: '註冊',
    toRegister: '還沒有帳號？註冊一個',
    toLogin: '已經有帳號了？登入',
    demoHint: '示範帳號已經幫你填好了，直接按登入就能看到含甘特、看板與對外詢問的示範資料。',
    /** 連不上後端是前端自己判斷的，不是後端回的訊息 */
    connectFailed: '連線失敗，請確認後端是否啟動',
  },
} as const
