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
    BUG: '問題',
  },
  priority: {
    LOW: '低',
    NORMAL: '普通',
    HIGH: '高',
    URGENT: '緊急',
  },

  /** 任務詳情（右側主區／抽屜） */
  drawer: {
    /**
     * 任務本身的種類（任務／問題／…）。**跟 `link.fieldType`（關聯類型）是兩回事**，
     * 兩個都叫「類型」會分不出來，所以這裡把「任務」講出來。
     * 選項是這個專案自己在系統參數頁定的，不是寫死的四種。
     */
    /**
     * 任務詳情不再改一格存一次 —— 改完按「保存」才送出。
     * 每動一下就打一次 API 的話，改三個欄位就是三筆活動紀錄、三次重畫，
     * 而且中途反悔沒有辦法收回。
     */
    save: '保存',
    saving: '儲存中…',
    saved: '已保存',
    discard: '還原',
    unsaved: '有還沒保存的修改',
    /** 沒有東西改過的時候，按鈕是灰的；游標停著說明為什麼 */
    nothingToSave: '沒有修改要保存',

    /** 刪除。兩段式：按一次問一句，再按一次才真的刪 */
    delete: '刪除任務',
    deleteConfirm: '確定要刪除嗎？',
    deleteYes: '確定刪除',
    deleteHasChildren: (n: number) => `這張任務底下還有 ${n} 張，會一起刪掉`,

    /** 標題平常是一行字，點一下才變成輸入框 */
    editTitle: '點一下改標題',
    fieldTaskType: '事件類型',
    /**
     * 標題列上、種類徽章後面的對外詢問狀況。
     *
     * 全部回來了就講「已回覆」一句話就好 —— 那是結束了的狀態，不需要數字。
     * 還有沒回的才給數字，而且跟側欄同一套寫法（「外 1」「逾 1」），
     * 兩個地方看到的東西要能對得起來。
     */
    /** 前面那個勾是字的一部分，不是圖示 —— 這一格很窄，一個勾比四個字省位置 */
    inquiryAllReplied: '✓ 已回覆',
    inquiryWaiting: (n: number) => `外 ${n}`,
    inquiryOverdue: (n: number) => `逾 ${n}`,
    inquiryWaitingTip: (n: number) => `${n} 件對外詢問還在等回覆`,
    inquiryOverdueTip: (n: number) => `${n} 件對外詢問過了期望回覆日還沒回`,
    fieldStatus: '狀態',
    /**
     * 還有對外詢問沒回的時候，「算是做完了」那幾個狀態不畫出來。
     * 少了選項一定要講原因 —— 無故消失比按了被拒絕更難懂。
     */
    statusBlockedByInquiry: (n: number) =>
      `還有 ${n} 件對外詢問沒回，先登錄回覆才選得到「做完」那幾個狀態。`,
    /** 保存鈕變灰時，游標停著看得到的原因 */
    saveBlockedByInquiry: (n: number) =>
      `還有 ${n} 件對外詢問沒回，這張任務還不能改成做完。`,
    fieldAssignee: '負責人',
    fieldPriority: '優先級',
    fieldStart: '開始日',
    fieldDue: '結束日',
    /** 進度是拖拉條旁邊直接顯示數字，標籤就不用再帶一個 % */
    fieldProgress: '進度',
    /** 拖拉條的無障礙名稱，以及旁邊那個數字 */
    progressAria: '進度百分比',
    progressValue: (n: number) => `${n}%`,
    fieldScheduleMode: '排程模式',
    scheduleAuto: '自動（依關聯推算日期）',
    scheduleManual: '人工鎖定（日期固定不被推動）',
    activityTitle: '活動紀錄',
    /** 沒有操作者的紀錄是系統自己寫的（例如排程推算） */
    systemActor: '系統',
  },

  /** 任務之間的關聯：有先後的（依賴）與沒先後的（相關） */
  link: {
    title: '任務關聯',
    titleHint: '（依賴與相關）',
    empty: '還沒有任何關聯。',
    lagDays: (days: number) => `間隔 ${days > 0 ? '+' : ''}${days} 天`,
    fieldTarget: '關聯到',
    fieldType: '關聯類型',
    fieldLag: '間隔（天）',
    pickTask: '選擇任務…',
    groupScheduling: '排程（會推動日期）',
    groupSemantic: '相關（不影響排程）',
    lagHint: '正數＝中間要空幾天；負數＝可以提前重疊',
    /**
     * 一邊是大項目、另一邊不是的時候，排程那一組整個不畫。
     * 少了一整組選項一定要講原因，不然看起來像壞掉。
     */
    noSchedulingAcrossEpic:
      '大項目與任務之間沒有先後 —— 大項目是「包含」底下那些任務，'
      + '日期也是由它們彙總出來的。要表達順序請在兩個大項目之間、或兩張任務之間建立；'
      + '只是想標示有關係的話用「相關」。',
    add: '建立關聯',
    /** 後端沒給訊息時才用這句，有訊息一律照後端的 */
    addFailed: '建立關聯失敗',
  },

  /**
   * 轉派（換負責人）。
   *
   * 換人走的是專屬的 POST /tasks/:id/reassign，不是一般的欄位更新 ——
   * 「換成誰」是欄位，「做到哪裡了、為什麼換」是話，兩者要一起進活動紀錄，
   * 接手的人才看得到來龍去脈。所以詳情裡改人會先跳一個交接說明的輸入框。
   */
  reassign: {
    /** 下拉裡「沒有負責人」那一項 */
    optionUnassigned: '不指派給任何人',
    /**
     * 現任負責人已經被移出專案時，還是要留在下拉裡 ——
     * 名單裡沒有他的話，畫面會顯示成別人，看起來像被偷偷換掉了
     */
    optionFormerMember: (name: string) => `${name}（已不是這個專案的成員）`,
    confirmChange: (from: string, to: string) => `要把負責人從 ${from} 換成 ${to}`,
    confirmAssign: (to: string) => `要把負責人指派給 ${to}`,
    confirmClear: (from: string) => `要收回 ${from} 的負責人身分，之後沒有人負責這張任務`,
    confirmClearNobody: '這張任務目前就沒有負責人',
    notePlaceholder: '交接說明：做到哪裡了、接手的人要先看什麼',
    noteHint: '交接說明可以留白。寫了的話，會跟著這次轉派一起留在活動紀錄裡。',
    submit: '確認轉派',
    /** 清單上直接換人，但不問交接說明 —— 那是逐張慢慢處理時才會寫的東西 */
    listHint: '在這裡可以直接換人。要附上交接說明，請開啟任務詳情再轉派。',
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
    inquiryAsk: (unit: string) => `詢問 ${unit}`,
    inquiryReply: (unit: string) => `登錄回覆${unit ? `（${unit}）` : ''}`,
    problemSet: (text: string) => `記下目前遇到的問題：${text}`,
    problemCleared: (before: string) => `把問題標為已解決${before ? `（原本：${before}）` : ''}`,
    /**
     * 轉派的四種句子。沒有原負責人、或收回不指派時，句子要各自成立 ——
     * 用同一句去填空的話，會拼出「把負責人從 （空白） 換成」這種讀不懂的字
     */
    reassigned: (from: string, to: string) => `把負責人從 ${from} 換成 ${to}`,
    assigned: (to: string) => `把負責人指派給 ${to}`,
    unassignedFrom: (from: string) => `收回了 ${from} 的負責人身分，目前沒有人負責`,
    unassignedNobody: '把負責人清空，目前沒有人負責',
    /** 那句交接說明，另起一行帶引號 */
    handoverNote: (text: string) => `「${text}」`,
    fieldUpdated: '更新了欄位',
  },

  /** 清單／樹狀視圖 */
  list: {
    colTask: '任務',
    colAssignee: '負責人',
    colStatus: '狀態',
    colInquiry: '對外詢問',
    colStart: '開始',
    colDue: '結束',
    colProgress: '進度',
    /**
     * 清單上每一列的新增鈕**只放一個「＋」**（2026-08-06 改，原本是「＋ 子任務」）。
     *
     * 一整排列的右邊都掛著三個字，掃下來全是同一句話，真正在變的
     * （標題、狀態、對外詢問）反而被擠掉。要做什麼交給游標停著時的提示講 ——
     * 那句話還是完整的「在『某某』底下新增子任務」，不是把說明拿掉。
     */
    addChild: '＋',
    addChildTip: (title: string) => `在「${title}」底下新增子任務`,
    addChildPlaceholder: (title: string) => `在「${title}」底下新增子任務`,
    addTask: '＋ 新增任務',
    addTaskPlaceholder: '任務標題',
    /** 新增那一列的送出鈕。Enter 一樣有效，但不能只有 Enter —— 沒人看得出來 */
    addSubmit: '新增',
    keepOpenHint: '建立後輸入框會留著，可以連續加好幾張',
    overdueTip: '已過結束日且尚未完成',
    derivedProgressTip: (total: number, done: number) =>
      `由 ${total} 個子任務加權平均算出（已完成 ${done} 個）`,
  },

  /** 看板 */
  board: {
    overdueCount: (count: number) => `${count} 逾期`,
    dropHere: '拖曳卡片到這裡',
    moveFailed: '移動任務失敗',
  },

  /**
   * 權限說明。後端的規則寫在 apps/api/src/routes/tasks.ts 的 assertCanEditTask：
   * 任務的內容只有開這張任務的人與專案管理者改得動，
   * 但「目前遇到的問題」與登錄對外詢問的回覆是每個專案成員都能做的。
   *
   * 沒權限的控制項一律不畫（不是畫出來再灰掉），所以這裡的句子是用來
   * 回答「為什麼這裡只剩文字」—— 少了這一句，畫面看起來只是壞掉。
   */
  permission: {
    readOnlyTitle: '這張任務你只能看，不能修改內容',
    readOnlyWhy: '任務的內容只有開這張任務的人與專案管理者可以修改。'
      + '你仍然可以填寫「目前遇到的問題」，也可以登錄對外詢問的回覆。',
    /** 清單上的狀態變成純文字時，游標停著看得到原因 */
    cannotChangeStatus: '狀態只有開這張任務的人與專案管理者可以調整',
    /** 負責人同上：改不動就只留名字，游標停著才說明原因 */
    cannotChangeAssignee: '負責人只有開這張任務的人與專案管理者可以調整',
    /** 看板上不能拖的卡片 */
    cannotDragCard: '這張任務不是你開的，不能拖動；'
      + '狀態要由開這張任務的人或專案管理者調整',
    /** 建立關聯兩端都要編輯權限，跟「誰開的」無關（見 api 的 routes/links.ts） */
    linkReadOnly: '建立與移除任務關聯需要專案編輯者以上的權限。',
  },
} as const
