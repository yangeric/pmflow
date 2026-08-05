/** 專案：選擇頁、建立、加入申請 用到的文字。寫法見 strings/index.ts */
export const project = {
  pickOne: '選一個專案開始',

  section: '專案',
  empty: '還沒有任何專案',
  createFirst: '建立第一個專案',
  createAnother: '建立新專案',
  taskCount: (n: number) => `${n} 個任務`,
  /** 首頁的專案卡片。只說「逾期未回」的話，看的人不知道是什麼東西逾期 */
  overdueUnreplied: (n: number) => `${n} 件對外詢問逾期`,
  pendingJoins: (n: number) => `${n} 人申請加入`,
  keyPlaceholder: '專案代碼，如 MRG',
  namePlaceholder: '專案名稱',

  /**
   * 公開與否的切換，只有專案建立者看得到。
   *
   * 文案的重點只有一件事：**公開只影響「找不找得到」，不影響「進不進得去」**。
   * 公開的專案會直接出現在別人的「加入其他專案」清單裡（不公開的要打對名稱或
   * 代碼才搜得到），但兩者一樣都要建立者核准才會變成成員，也一樣看不到裡面的任務。
   * 少講後半句，使用者會以為按下去就是把專案內容攤開給整個工作區看。
   */
  visibility: {
    /** 切換上的字：講「現在是什麼狀態」，不是「按下去會變成什麼」 */
    label: (isPublic: boolean) => (isPublic ? '公開' : '不公開'),
    /** 卡片上跟著切換的那行小字，一句話同時交代找得找不到、以及加入仍要核准 */
    hint: (isPublic: boolean) =>
      isPublic ? '不用搜尋就找得到，加入仍要你核准' : '要搜尋才找得到，加入仍要你核准',
    /** 游標停著看的完整說明。分三行：現在怎樣、公開不等於看得到內容、按下去會怎樣 */
    tooltip: (isPublic: boolean) =>
      (isPublic
        ? '目前是公開：同工作區的人不用搜尋，就會在「加入其他專案」看到這個專案的名稱。'
        : '目前是不公開：只有打對專案名稱或代碼的人，才搜尋得到這個專案。')
      + '\n公開只影響找不找得到 —— 不論公開與否，別人都要經過你核准才會成為成員，'
      + '在那之前一樣看不到裡面的任務。'
      + `\n按一下改成${isPublic ? '不公開' : '公開'}。`,
    ariaLabel: (isPublic: boolean, name: string) =>
      `${name}：目前${isPublic ? '公開' : '不公開'}，按一下改成${isPublic ? '不公開' : '公開'}`,
    failed: '公開設定沒改成功，請再試一次',
  },

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
