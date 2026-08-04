/** 專案：選擇頁、建立、加入申請 用到的文字。寫法見 strings/index.ts */
export const project = {
  pickOne: '選一個專案開始',
  inquiryHint: '跨所有專案，看發出去的事情回了沒',
  overdueCount: (n: number) => `${n} 件逾期`,

  section: '專案',
  empty: '還沒有任何專案',
  createFirst: '建立第一個專案',
  createAnother: '建立新專案',
  taskCount: (n: number) => `${n} 個任務`,
  overdueUnreplied: (n: number) => `${n} 件逾期未回`,
  pendingJoins: (n: number) => `${n} 人申請加入`,
  keyPlaceholder: '專案代碼，如 MRG',
  namePlaceholder: '專案名稱',

  join: {
    section: '加入其他專案',
    hint: '輸入專案名稱或代碼搜尋。要進去得由專案的建立者同意。',
    searchPlaceholder: '專案名稱或代碼，例如 MRG',
    notFound: (q: string) => `找不到叫「${q}」的專案。`,
    notFoundHint: '名稱要對得上，或直接輸入專案代碼；已經加入的專案不會出現在這裡。',
    /** 建立者與人數合成一句，中文的語序不適合在畫面上拼字串 */
    creatorAndMembers: (creator: string | null | undefined, members: number) =>
      `${creator ? `${creator} 建立` : '建立者不明'}．${members} 位成員`,
    pending: '審核中',
    cancel: '撤回申請',
    messagePlaceholder: '想說明一下原因嗎？（可留白）',
    submit: '送出申請',
    apply: '申請加入',
    failed: '申請失敗',
  },
} as const
