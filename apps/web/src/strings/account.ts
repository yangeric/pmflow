import type { AdminUser, ProjectRole, WorkspaceRole } from '../lib/api'

/** 帳號設定、系統管理、成員 用到的文字。寫法見 strings/index.ts */

/**
 * 角色與狀態的中文名稱獨立成 const 而不是直接寫在下面的物件裡，
 * 是為了掛上 Record<角色, string> —— 後端哪天多一種角色，這裡會直接編譯不過，
 * 而不是在畫面上默默印出 'OWNER' 這種給程式看的字。
 */
const workspaceRole: Record<WorkspaceRole, string> = {
  OWNER: '擁有者', ADMIN: '管理者', MEMBER: '成員', GUEST: '訪客',
}

const workspaceRoleHint: Record<WorkspaceRole, string> = {
  OWNER: '開站的人。只能決定誰是管理者，看不到也管不了別人的帳號',
  ADMIN: '能開帳號、停用帳號、刪除帳號、調整成員與訪客的角色',
  MEMBER: '一般使用者：能開專案、能申請加入別人的專案',
  GUEST: '只能被邀請進專案，開不了新專案',
}

const userStatus: Record<AdminUser['status'], string> = {
  ACTIVE: '正常', PENDING: '未啟用', SUSPENDED: '已停用',
}

const projectRole: Record<ProjectRole, string> = {
  MANAGER: '管理者', EDITOR: '編輯者', COMMENTER: '可留言', VIEWER: '唯讀',
}

export const account = {
  workspaceRole,
  workspaceRoleHint,
  userStatus,
  projectRole,

  /** 右上角頭像選單 */
  menu: {
    account: '帳號設定',
    admin: '系統管理',
    logout: '登出',
    appearance: '外觀',
    themeLight: '淺色',
    themeDark: '深色',
    themeSystem: '跟隨系統',
  },

  /** 帳號設定頁 */
  title: '帳號設定',
  loading: '載入帳號資料…',

  avatar: {
    title: '頭像',
    pick: '選一張圖',
    replace: '換一張',
    working: '處理中…',
    hint: '支援 PNG、JPEG、WebP。圖會自動取中間的正方形、縮成 256 見方再上傳。'
        + '沒有頭像時顯示名字算出來的色塊。',
  },

  profile: {
    title: '基本資料',
    displayName: '顯示名稱',
    email: 'email（也是登入帳號）',
    hint: '改了 email 之後就要用新的 email 登入。站上沒有寄驗證信的機制，改完立刻生效。',
  },

  password: {
    title: '變更密碼',
    current: '目前的密碼',
    next: '新密碼（至少 8 個字元）',
    again: '再輸入一次新密碼',
    mismatch: '兩次輸入的新密碼不一樣。',
    hint: '改完密碼所有裝置都要重新登入，包含現在這一台。',
    submit: '變更密碼並重新登入',
  },

  token: {
    title: 'API 權杖',
    hint: '讓別的系統或腳本代替你呼叫這個站的介面，例如自動建立任務。'
        + '用權杖呼叫等於你本人在呼叫，看得到、改得動的東西跟你登入時完全一樣，'
        + '所以請把它當成密碼保管。改密碼不會讓權杖失效，要停用請在下面撤銷。',
    plaintextWarning: '這是新權杖的內容，只會顯示這一次。'
                    + '關掉之後就再也看不到了，請先複製並貼到要用的系統裡。',
    copy: '複製',
    copied: '已複製',
    dismiss: '我收好了，關閉',
    name: '用途名稱（例如：報修系統、每日匯入腳本）',
    namePlaceholder: '這把權杖給誰用',
    expiresOn: '用到哪一天（可留空）',
    create: '建立權杖',
    createHint: '留空代表不會過期。到期日填的那一天當天仍然可以使用。',
    loading: '載入權杖…',
    empty: '還沒有建立任何權杖。',
    expired: '已過期',
    createdAt: (at: string) => `建立於 ${at}`,
    lastUsedAt: (at: string) => `最後使用 ${at}`,
    neverUsed: '從未使用',
    until: (day: string) => `用到 ${day}`,
    noExpiry: '不會過期',
    revoke: '撤銷',
    confirmRevoke: (name: string) =>
      `撤銷「${name}」之後，用它呼叫的系統會立刻失效。確定要撤銷嗎？`,
  },

  workspaces: {
    title: '我在哪些工作區',
    hint: '這裡的角色管的是「誰能登入這個站、誰能開帳號」，跟你在各專案裡的角色是兩回事。',
  },

  /** 系統管理（管理者看到的） */
  admin: {
    title: '系統管理',
    myRole: (role: string) => `你的身分：${role}`,
    loading: '載入帳號…',
    createToggle: '新增帳號',
    updated: '已更新',
    created: (name: string) => `已建立 ${name}，請把密碼當面給他`,
    deleted: (name: string) => `已刪除 ${name}`,
    deletedWithProjects: (name: string, count: number) =>
      `已刪除 ${name}，他開的 ${count} 個專案已經轉到你名下`,

    createTitle: '新增帳號',
    email: 'email（登入帳號）',
    displayName: '顯示名稱',
    initialPassword: '初始密碼（至少 8 個字元）',
    role: '工作區角色',
    noMailHint: '站上沒有寄信的機制 —— 密碼不會寄給對方，請當面或用其他管道給他，'
              + '並請他登入後自己到「帳號設定」改掉。',

    colAccount: '帳號',
    colStatus: '狀態',
    colProjects: '參與專案',
    colRole: '角色',
    footHint: '這裡的角色管的是「誰能登入這個站、誰能開帳號」。'
            + '誰進得了哪個專案，仍然由那個專案的建立者決定 —— 管理者看不到別人的專案內容。',

    me: '你',
    projectCount: (n: number) => `${n} 個`,
    createdCount: (n: number) => `（開了 ${n}）`,

    resetPassword: '重設密碼',
    promptNewPassword: (name: string) => `要幫 ${name} 設一組新密碼嗎？（至少 8 個字元）`,
    passwordTooShort: '密碼至少要 8 個字元',

    suspend: '停用',
    resume: '復用',
    confirmResume: (name: string) => `要讓 ${name} 重新登入嗎？`,
    confirmSuspend: (name: string) => `要停用 ${name} 嗎？他會立刻被登出，資料不會刪除。`,

    // 刪除的說明拆成幾句，是因為有沒有「他開的專案」會差一行，拼成一整句就搬不動了
    confirmDelete: (name: string) => `要刪除 ${name} 的帳號嗎？這個動作無法復原。`,
    confirmDeleteProjects: (count: number) =>
      `他開的 ${count} 個專案會轉到你名下（不然那些專案就沒有人能管成員了）。`,
    confirmDeleteTasks: '他負責的任務不會被刪除，只會變成未指派。',
    confirmDeleteSuspendInstead: '只是暫時不讓他登入的話，請用「停用」。',
  },

  /** 系統管理（擁有者看到的，只有指派管理者這件事） */
  owner: {
    loading: '載入名單…',
    myRole: '你的身分：擁有者',
    intro: '你能決定誰是管理者，其餘的帳號管理都由管理者處理 —— '
         + '你看不到別人的帳號狀態，也不能開帳號、停用或刪除帳號。',
    noAdmins: '目前沒有任何管理者，這個站沒有人能開帳號或重設密碼。請先指派一位。',
    meOwner: '你（擁有者）',
    isAdmin: '管理者',
    grant: '指派為管理者',
    revoke: '取消管理者',
    confirmGrant: (name: string) =>
      `要讓 ${name} 當管理者嗎？他就能看到、也能管理這個站上所有人的帳號。`,
    confirmRevoke: (name: string) => `要取消 ${name} 的管理者身分嗎？他會變回一般成員。`,
    footHint: '管理者管的是「誰能登入這個站」，看不到任何專案的內容 —— '
            + '誰進得了哪個專案，仍然由那個專案的建立者決定。',
  },

  /** 專案成員 */
  members: {
    loading: '載入成員…',
    requestsTitle: '加入申請',
    requestsPending: (n: number) => `${n} 件待處理`,
    requestsEmpty: '目前沒有人申請加入',
    approve: '核准',
    reject: '婉拒',

    title: '成員',
    count: (n: number) => `${n} 人`,
    readonlyHint: '只有專案的建立者可以增減成員',
    empty: '這個專案還沒有成員。',
    creator: '建立者',
    confirmRemove: (name: string) => `要把 ${name} 移出這個專案嗎？`,

    addTitle: '直接加入成員',
    pickUser: '選一個帳號…',
    userOption: (name: string, email: string) => `${name}（${email}）`,
    add: '加入',
    addHint: '只列得出同一個工作區裡的帳號。對方不會收到信，直接就是成員了。',
    addNoneLeft: '同工作區的帳號都已經在這個專案裡了。',
  },
} as const
