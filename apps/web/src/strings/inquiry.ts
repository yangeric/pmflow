/** 對外詢問用到的文字。寫法見 strings/index.ts */
export const inquiry = {
  /** 徽章。這是整個系統最常被看到的四個字，改之前想清楚 */
  badge: {
    awaiting: '待回覆',
    overdue: '逾期未回',
    partial: '部分已回',
    replied: '已回覆',
  },

  /**
   * 帶天數的說法。表格與看板講的是同一件事，各寫一份就會出現
   * 「逾期 3 天」與「已逾期 3 天」並存 —— 一律從這裡拿。
   */
  overdueDays: (n: number) => `逾期 ${n} 天`,
  elapsedDays: (n: number) => `已 ${n} 天`,
  waitedDays: (n: number) => `已等 ${n} 天`,
  repliedInDays: (n: number) => `${n} 天回覆`,
  /** 統計的平均值後端是用字串送的（避免浮點誤差），這裡照收不轉型 */
  days: (n: number | string) => `${n} 天`,
  percent: (n: number | string) => `${n}%`,

  /** 任務詳情裡的對外詢問表格 */
  table: {
    title: '對外詢問',
    add: '＋ 新增單位',
    empty: '還沒有對外詢問紀錄。按「＋ 新增單位」記錄這件事提給了誰。',
    column: {
      askedToUnit: '提給單位',
      askedToPerson: '承辦人',
      contact: '聯絡方式',
      askedAt: '提問日',
      dueDate: '期望回覆',
      status: '狀態',
      repliedByUnit: '回覆單位',
      repliedByPerson: '回覆人',
      repliedAt: '回覆日',
    },
    editDue: '改期望回覆日',
    transferred: '轉單位',
    reopen: '退回待回覆',
    markReplied: '登錄回覆',
    /** 新增時提問日一律是今天，所以顯示字而不是日期 */
    askedToday: '今天',
    status: {
      replied: '已回覆',
      /** 接在「已回覆」後面的括號，語序跟中文綁著，不要在元件裡拼 */
      repliedDays: (n: number) => `（${n} 天）`,
    },
    placeholder: {
      unit: '例如 採購部',
      person: '王小明',
      contact: '分機 2145',
      question: '要問什麼？（選填）',
      replyNote: '回覆重點摘要（選填）',
    },
    reply: {
      heading: (unit: string) => `登錄「${unit}」這筆的回覆`,
      unitChanged: '← 回覆單位已改成別的單位',
      mark: '已回覆',
      submit: '確認',
    },
  },

  /** 期望回覆日：「幾天後回覆」那組選項 */
  due: {
    label: '幾天後回覆',
    preset: {
      D1: '1 個工作天（很急）',
      D3: '3 個工作天',
      D5: '5 個工作天（約一週）',
      D7: '7 個工作天',
      D10: '10 個工作天（約兩週）',
      D14: '14 個工作天（約三週）',
      M1: '一個月後',
      NONE: '不設期限',
      CUSTOM: '自訂日期',
    },
    /** 算出來的那一天。日期與星期都由元件先格式化好再帶進來 */
    resolved: (date: string, weekday: string) => `＝ ${date}（週${weekday}）`,
    noDeadline: '不設期限，不會列入逾期',
  },

  /** 單位輸入框的提示清單 */
  unit: {
    usage: (n: number) => `用過 ${n} 次`,
  },

  /** 專案裡的對外詢問頁籤，只看得到這個專案的 */
  board: {
    title: '對外詢問',
    subtitle: '這個專案發出去的事情回了沒',
    groupByUnit: '依單位分組',
    emptyColumn: '沒有項目',
    empty: '這個專案還沒有對外詢問紀錄。到任務詳情頁的「對外詢問」新增一筆。',
    /** 分組標題後面的件數 */
    groupCount: (n: number) => `(${n})`,
    stats: {
      title: '單位回覆統計',
      unit: '單位',
      totalAsked: '詢問次數',
      totalReplied: '已回覆',
      currentOverdue: '目前逾期',
      avgDaysToReply: '平均回覆天數',
      lateReplyRate: '逾期回覆率',
    },
    transfer: {
      title: '轉單位回覆的案例',
      entry: (from: string, to: string, count: number) => `${from} → ${to}（${count} 次）`,
      note: '提問側與回覆側分開存，才問得出這件事。',
    },
    card: {
      open: (ref: string, title: string) => `開啟 ${ref}：${title}`,
      /** 卡片上的期望回覆日只印月日，日期由元件先切好 */
      due: (date: string) => `期望 ${date}`,
    },
  },
} as const
