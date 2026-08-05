/** 行事曆（含請假）用到的文字。寫法見 strings/index.ts */
export const calendar = {
  prevMonth: '上個月',
  nextMonth: '下個月',
  today: '今天',

  /** 工具列上的三個開關，數字接在後面 */
  filterTasks: '任務',
  filterInquiries: '期望回覆日',
  filterLeaves: '請假',
  dragHint: '任務與期望回覆日拖到哪一天，就從那天開始（長度不變）；請假要改期請點開來改',

  undated: (n: number) => `未排期 ${n}`,
  undatedMore: (n: number) => `還有 ${n} 張`,
  hiddenCount: (n: number) => `還有 ${n} 筆`,
  empty: '這個工作區還沒有帶日期的任務。到清單或看板設定開始日與到期日，就會出現在這裡。',

  /** 拖曳時跟著游標走的那一塊 */
  dragTask: (title: string, days: number) => `${title}（${days} 天）`,
  dragInquiry: (unit: string, title: string) => `${unit}：${title}`,

  /**
   * 游標停著看的完整說明。長條上只放得下幾個字，
   * 是哪一張任務、幾號到幾號都靠這一句講完。
   */
  taskTooltip: (ref: string, title: string, start: string, end: string, days: number) =>
    `${ref} ${title}｜${start} – ${end}（${days} 天）`,
  inquiryTooltip: (unit: string, title: string, day: string) =>
    `${unit}｜${title}｜期望 ${day} 前回覆`,
  undatedTooltip: (ref: string, title: string) => `${ref} ${title}｜拖到日期上就會排期`,

  /**
   * ── 請假 ──
   * 假別的 key 跟後端、資料表三邊必須一致
   * （見 api/src/routes/leaves.ts 的 LEAVE_TYPES），這裡只負責中文說法。
   */
  leave: {
    types: {
      PERSONAL: '事假',
      SICK: '病假',
      ANNUAL: '特休',
      OFFICIAL: '公假',
      MARRIAGE: '婚假',
      BEREAVEMENT: '喪假',
      OTHER: '其他假別',
    },

    /** 長條上放得下的字：誰、請哪一種假 */
    bar: (name: string, type: string) => `${name}　${type}`,
    /** 游標停著看的完整說明。備註只有本人與管理者拿得到，沒有就不接在後面 */
    tooltip: (name: string, type: string, start: string, end: string, days: number) =>
      `${name}｜${type}｜${start} – ${end}（共 ${days} 天）`,
    tooltipWithNote: (base: string, note: string) => `${base}｜備註：${note}`,
    /** 不能改的那幾筆，講清楚為什麼點了沒反應 */
    tooltipReadOnly: (base: string) => `${base}｜只有本人與工作區管理者可以修改`,

    /** 工具列上的入口 */
    add: '登記請假',
    addTitle: '登記請假',
    editTitle: '修改請假',

    /** 表單欄位 */
    fieldUser: '請假的人',
    fieldType: '假別',
    fieldStart: '開始日期',
    fieldEnd: '結束日期',
    fieldNote: '備註（選填）',
    notePlaceholder: '例如：出國、家中有事，只有本人與工作區管理者看得到',
    /** 幫別人填是管理者的權力，不是管理者時只會看到自己 */
    selfOption: '我自己',
    userHint: '你是這個工作區的管理者，可以幫其他人登記請假。',
    /** 表單上即時算出來的天數，含頭含尾 */
    dayCount: (n: number) => `共 ${n} 天（含開始日與結束日）`,

    /** 送出前先在畫面上擋一次，不要等後端才講 */
    errorRange: '開始日期不能晚於結束日期。',
    errorRequired: '請把假別與起訖日期都填好。',
    saveFailed: '請假存不起來，請再試一次。',
    deleteFailed: '這筆請假刪不掉，請再試一次。',
    loadFailed: '請假資料讀不到，行事曆上暫時不會顯示請假。',
    deleteConfirm: (name: string, start: string, end: string) =>
      `確定要刪掉「${name}　${start} – ${end}」這筆請假嗎？刪掉之後不能還原。`,

    /** 這個月完全沒有人請假時，開關旁邊的數字仍然是 0，不另外提示 */
    createdBy: (name: string) => `由 ${name} 代為登記`,
  },
} as const
