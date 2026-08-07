import { T } from '../strings'

const BASE = '/api/v1'

let accessToken: string | null = null
export const setAccessToken = (t: string | null) => { accessToken = t }
export const getAccessToken = () => accessToken

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: string,
    public payload?: Record<string, unknown>
  ) { super(title) }
}

let refreshing: Promise<boolean> | null = null

/** access token 過期時自動用 refresh cookie 換一張，只跑一次避免打雷同請求 */
async function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
      if (!r.ok) return false
      const data = await r.json()
      accessToken = data.accessToken
      return true
    } catch { return false }
    finally { setTimeout(() => { refreshing = null }, 0) }
  })()
  return refreshing
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
  retry = true
): Promise<T> {
  const headers = new Headers(init.headers)
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
  if (init.json !== undefined) headers.set('content-type', 'application/json')

  const res = await fetch(BASE + path, {
    ...init,
    headers,
    credentials: 'include',
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  })

  if (res.status === 401 && retry && accessToken) {
    if (await tryRefresh()) return api<T>(path, init, false)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : null

  if (!res.ok) {
    throw new ApiError(res.status, data?.title ?? `HTTP ${res.status}`, data?.detail, data)
  }
  return data as T
}

/** 把只有部分有值的查詢參數接成 `?a=1&b=2`；全空就回空字串，網址不會多一個問號 */
function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ── 型別 ────────────────────────────────────────────────
export interface User { id: string; email: string; displayName: string }
export interface Workspace { id: string; name: string; slug: string; role: string }

export interface Project {
  id: string; workspaceId: string; key: string; name: string
  description?: string | null; color: string
  startDate?: string | null; endDate?: string | null
  role?: string; taskCount?: number; overdueInquiryCount?: number
  isCreator?: boolean; pendingJoinRequestCount?: number
  /** 公開只影響「找不找得到」，不影響「進不進得去」。見 api 的 0010 migration */
  isPublic?: boolean
}

export type ProjectRole = 'MANAGER' | 'EDITOR' | 'COMMENTER' | 'VIEWER'

/** 假別。中文說法在 strings/calendar.ts，這裡跟後端一樣只認 key */
export type LeaveType =
  | 'PERSONAL' | 'SICK' | 'ANNUAL' | 'OFFICIAL' | 'MARRIAGE' | 'BEREAVEMENT' | 'OTHER'

/**
 * 一筆請假。**備註只有本人與工作區管理者拿得到**，其他人看到的是 null ——
 * 那是後端濾掉的，不是前端不畫（見 api/src/routes/leaves.ts）。
 */
export interface Leave {
  id: string
  userId: string
  userName: string
  leaveType: LeaveType
  /** 含頭含尾的日曆日，一律 YYYY-MM-DD */
  startDate: string
  endDate: string
  days: number
  note: string | null
  createdById: string | null
  createdByName: string | null
  createdAt: string
  /** 這個人能不能改這一筆。本人或管理者才是 true */
  canEdit: boolean
}

/** 同工作區的帳號，給建立者挑人加進專案用 */
export interface WorkspaceUser {
  id: string; displayName: string; email: string; role: string
}

/** 工作區層級的角色。跟專案角色（ProjectRole）是兩回事 */
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'

export interface MyProfile {
  id: string; email: string; displayName: string
  locale: string; timezone: string; createdAt: string
  /** 檔名。有值代表有頭像，圖片本身走 GET /users/:id/avatar */
  avatarFile: string | null
}

/**
 * 給外部系統用的長期憑證。
 *
 * 這裡永遠拿不到明文 —— 只有建立那一次的回應會帶 plaintext，之後看得到的
 * 只有 prefix（開頭幾碼），用來認出手上那把是清單裡的哪一把。
 */
export interface ApiToken {
  id: string; name: string; prefix: string
  createdAt: string
  lastUsedAt: string | null
  /** 用到哪一天為止（YYYY-MM-DD，含當天）。null 代表不會過期 */
  expiresOn: string | null
}

// ── 用 Google／Apple 的帳號登入 ──
/**
 * 站台可能一家都沒設定 —— 後端只回**設定齊全**的那幾家，
 * 所以前端不必判斷任何環境變數，清單是空的就不要畫按鈕。
 */
export type OauthProviderId = 'GOOGLE' | 'APPLE'

export interface OauthProvider { id: OauthProviderId; label: string }

/**
 * 一筆綁定。`email` 與 `displayName` 是**授權當下對方給的值**，只當參考 ——
 * Apple 給的可能是轉寄用的假地址，名字也只有第一次授權才會有。
 */
export interface OauthIdentity {
  id: string
  provider: OauthProviderId
  email: string | null
  displayName: string | null
  createdAt: string
  lastLoginAt: string | null
}

export interface MyIdentities {
  /** 沒有密碼的人，手上至少要留兩個綁定才解得掉其中一個 */
  hasPassword: boolean
  identities: OauthIdentity[]
  /** 現在還可以綁哪幾家（已經綁過的與站台沒設定的都不在裡面） */
  available: OauthProviderId[]
  /** 後端算好的「現在能不能解除」。前端只負責照它收起按鈕，不要自己再算一次 */
  canUnlink: boolean
}

/** 管理者看到的帳號一覽 */
export interface AdminUser {
  id: string; email: string; displayName: string
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED'
  role: WorkspaceRole; joinedAt: string
  projectCount: string; createdCount: string
}

/**
 * 擁有者指派管理者時看到的名單。
 * 刻意只有名字與 email —— 擁有者的職權只剩指派管理者，帳號的狀態、
 * 參與幾個專案這些細節不該讓他看（見 api/src/lib/auth.ts）。
 */
export interface AdminCandidate {
  id: string; displayName: string; email: string
  isAdmin: boolean; isOwner: boolean
}

export interface ProjectMember {
  id: string; displayName: string; email: string
  role: ProjectRole; joinedAt: string; isCreator: boolean
  hasAvatar: boolean
}

/**
 * 成員頁上的一列任務。刻意比 `Task` 少很多欄位 ——
 * 那一頁只要看得出「是哪一張、做到哪、什麼時候到期」，
 * 不是第二個任務清單頁；點下去會開任務詳情，細節在那裡看。
 */
export interface MemberTask {
  id: string; ref: string; title: string
  /** 專案自己定義的種類鍵（EPIC / TASK / BUG / MILESTONE 或自訂的） */
  type: string
  statusKey: string; progress: number
  startDate: string | null; dueDate: string | null
  inquiryState: InquiryState
  /** 現在的負責人。「曾經的任務」那一區要靠它講出「現在是誰負責」 */
  assigneeId: string | null; assigneeName: string | null
  assigneeHasAvatar: boolean
}

/**
 * 從他手上轉出去、現在不在他身上的任務。
 * 多的三件事就是這一區存在的理由：現在在誰身上（上面的 assigneeName）、
 * 哪一天轉出去的、轉的時候附了什麼交接說明。
 */
export interface PastMemberTask extends MemberTask {
  /** YYYY-MM-DD。後端已經照資料庫時區格好了，前端不要再轉一次 */
  handedOverOn: string
  handoverNote: string | null
}

/** 別人送來的加入申請（只有建立者看得到） */
export interface JoinRequest {
  id: string; userId: string; displayName: string; email: string
  message: string | null; status: string; createdAt: string
}

/** 自己送出去的加入申請 */
export interface MyJoinRequest {
  id: string; projectId: string; projectKey: string; projectName: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  message: string | null; decidedNote: string | null
  createdAt: string; decidedAt: string | null
}

/** 同工作區、自己還不是成員的專案 */
export interface JoinableProject {
  id: string; key: string; name: string; description: string | null; color: string
  createdByName: string | null; memberCount: number
  myRequestStatus: string | null; myRequestId: string | null
}

/**
 * 通知。刻意不叫 Notification —— 那是瀏覽器的全域型別，同名會蓋掉。
 *
 * 四種事件共用同一個型別，各自需要的細節放在 body：
 *   TASK_LINKED     有人建立了一條指向我負責的任務的關聯 → body.linkType / otherRef
 *   TASK_ASSIGNED   有人把任務指派給我
 *   JOIN_REQUESTED  有人申請加入我開的專案 → body.message
 *   JOIN_APPROVED   我的申請被核准，或被建立者直接加入 → body.role / direct
 */
export type NotificationKind =
  'TASK_LINKED' | 'TASK_ASSIGNED' | 'JOIN_REQUESTED' | 'JOIN_APPROVED'

export interface AppNotification {
  id: string; kind: NotificationKind
  actorName: string | null
  projectId: string | null; projectKey: string | null; projectName: string | null
  taskId: string | null; taskRef: string | null; taskTitle: string | null
  body: Record<string, unknown> | null
  readAt: string | null; createdAt: string
}

export interface TaskStatus {
  id: string; key: string; name: string
  category: 'TODO' | 'ACTIVE' | 'DONE'; color: string; rank: number
}

/**
 * 每個專案自己的下拉清單。狀態欄本來就是這樣（`task_status`），
 * 優先度與任務類型原本寫死在資料表的 CHECK 裡，現在也各自成表。
 *
 * **是每個專案改自己的，不是全站一份** —— 蓋房子的專案要「圖說審查中」，
 * 辦活動的專案要「等廠商報價」，硬要共用一套只會逼所有人遷就別人的流程。
 */
export type ParamKind = 'status' | 'priority' | 'type'

export interface ProjectParam {
  id: string
  kind: ParamKind
  /** 程式用的鍵。建立之後不能改 —— 任務是靠它指回來的 */
  key: string
  name: string
  color: string
  rank: number
  /** 只有狀態有：決定它算不算「還沒做完」 */
  category?: 'TODO' | 'ACTIVE' | 'DONE'
  /** 目前有幾張任務用著它。要刪的時候得先知道會影響多少 */
  inUse: number
}

export type InquiryState = 'NONE' | 'AWAITING' | 'OVERDUE' | 'PARTIAL' | 'REPLIED'

export interface Task {
  id: string; projectId: string; ref: string; number: number
  parentId: string | null; title: string; description?: string | null
  /**
   * 目前遇到的問題。人自己打字寫的，解決了就清成 null。
   * 跟關聯圖算出來的「卡住」是兩回事 —— 那個沒有欄位，是看關聯推出來的。
   */
  problem: string | null
  type: 'TASK' | 'MILESTONE' | 'BUG' | 'EPIC'
  statusKey: string; priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  assigneeId: string | null; assigneeName: string | null
  assigneeHasAvatar: boolean
  startDate: string | null; dueDate: string | null
  estimateHours: string | null; progress: number
  scheduleMode: 'AUTO' | 'MANUAL'; rank: string
  inquiryState: InquiryState; earliestDueDate: string | null
  /**
   * 誰開的這張任務。前端要用它決定「這個人能不能改」——
   * 改任務只有開的人與專案管理者可以（規則在後端 `assertCanEditTask`，
   * 這裡只是不要畫出按了會被拒絕的按鈕）。
   */
  createdById: string | null
}

export type LinkType = 'FS' | 'SS' | 'FF' | 'SF' | 'RELATES' | 'BLOCKS' | 'DUPLICATES' | 'REQUIRES'

export interface TaskLink {
  id: string; linkType: LinkType; lagDays: number
  direction: 'outgoing' | 'incoming'
  otherId: string; otherRef: string; otherTitle: string
}

export interface Inquiry {
  id: string; seq: number
  askedToUnit: string; askedToPerson: string | null; askedToContact: string | null
  askedAt: string; dueDate: string | null; question: string | null
  isReplied: boolean
  repliedByUnit: string | null; repliedByPerson: string | null
  repliedAt: string | null; replyNote: string | null
  status: 'AWAITING' | 'OVERDUE' | 'REPLIED'
  daysElapsed: number; daysToReply: number | null; daysOverdue: number | null
}

export interface Activity {
  id: string; kind: string; body: Record<string, unknown> | null
  actorName: string | null; createdAt: string
}

export interface TaskDetail extends Task {
  links: TaskLink[]
  children: Array<{ id: string; ref: string; title: string; statusKey: string; progress: number }>
  inquiries: Inquiry[]
  activities: Activity[]
}

/**
 * ── 儀表板 ──
 *
 * 兩張圖共用一個計算單位：`count` 是任務張數，`hours` 是預估工時。
 * 同一個畫面上兩張圖用不同單位，看的人一定會把它們讀成同一件事。
 */
export type DashboardMetric = 'count' | 'hours'

/**
 * 燃盡圖的一天。
 *
 * **這條線是回推出來的，不是每天存一筆存下來的** —— 系統沒有背景排程器，
 * 沒有人半夜幫忙照相。作法是拿 `activity` 的狀態變更一天一天重播回去
 * （見 api/src/lib/burndown.ts）。因此舊資料會有查不到的洞，
 * 那些用「最後更新時間」估，數量在 `estimatedCount` 裡誠實回報。
 */
export interface BurndownPoint {
  /** YYYY-MM-DD。日期一律字串，不要轉成 Date 再轉回來（UTC+8 會位移一天） */
  date: string
  /** 當天結束時還沒做完的量。今天之後的日子是 null —— 未來沒有實際值 */
  remaining: number | null
  /** 當天結束時的總量。中途才開的任務會讓它往上跳，那正是要看見的事 */
  total: number | null
  /** 當天累計完成的量 */
  done: number | null
  /** 照計畫應該剩下多少。參考線，不是資料，畫成虛線 */
  ideal: number
  /** 今天之後 */
  isFuture: boolean
  isWeekend: boolean
  isToday: boolean
}

export interface BurndownResult {
  from: string
  to: string
  metric: DashboardMetric
  points: BurndownPoint[]
  /** 算進來的任務張數 */
  taskCount: number
  /**
   * 有幾張任務的完成時間是估的（活動紀錄裡查不到那次狀態變更）。
   * 大於 0 一定要在畫面上講出來 —— 看的人有權知道哪幾張是猜的。
   */
  estimatedCount: number
  /** 到今天為止的實際值與理想值，給圖上方那幾個數字用。今天不在區間內就是 null */
  todayRemaining: number | null
  todayIdeal: number | null
}

/** 熱圖的一格 = 一個人的一天 */
export interface WorkloadCell {
  date: string
  /** 落在這一天的量。metric=count 是任務張數，hours 是攤平之後的工時 */
  load: number
  taskCount: number
  /** 這天請假。請假還壓著事情的格子是熱圖最值得看的東西 */
  onLeave: boolean
}

export interface WorkloadRow {
  /** null 代表「沒有指定負責人」那一列。那些事不能消失在圖外 */
  userId: string | null
  displayName: string
  hasAvatar: boolean
  cells: WorkloadCell[]
  total: number
  /** 這個人最高的一天 */
  peak: number
}

export interface WorkloadResult {
  from: string
  to: string
  metric: DashboardMetric
  days: Array<{ date: string; isWeekend: boolean; isToday: boolean }>
  rows: WorkloadRow[]
  /**
   * 當作滿載的量（工時是每天幾小時、張數是每天幾張）。
   * 這是畫紅字的門檻，不是規定誰要做幾小時。
   */
  capacity: number
  /** 整張圖最高的一格，色階拿它當上限 */
  max: number
}

export interface ScheduleResult {
  tasks: Record<string, { start: string | null; finish: string | null; totalFloat: number | null }>
  criticalPath: string[]
  conflicts: Array<{ taskId: string; label: string; reason: string }>
  cyclic: boolean
}

// ── 端點 ────────────────────────────────────────────────
export const Api = {
  login: (email: string, password: string) =>
    api<{ accessToken: string; user: User }>('/auth/login', { method: 'POST', json: { email, password } }),
  register: (json: { email: string; password: string; displayName: string }) =>
    api<{ accessToken: string; user: User; isFirstUser: boolean }>('/auth/register', { method: 'POST', json }),
  logout: () => api('/auth/logout', { method: 'POST' }),
  me: () => api<{ user: User; workspaces: Workspace[] }>('/auth/me'),

  // ── 用 Google／Apple 的帳號登入 ──
  /** 登入頁要畫哪幾顆按鈕。沒設定的那一家不會出現在這份清單裡 */
  oauthProviders: () => api<{ providers: OauthProvider[] }>('/auth/oauth/providers'),
  /** 我綁了哪幾種，還能不能解除 */
  oauthIdentities: () => api<MyIdentities>('/me/oauth/identities'),
  /** 綁定用的一次性入場券（60 秒）。整頁跳轉帶不了 Authorization 標頭，所以要這一步 */
  oauthLinkTicket: () => api<{ ticket: string }>('/me/oauth/link-ticket', { method: 'POST' }),
  unlinkOauthIdentity: (id: string) =>
    api(`/me/oauth/identities/${id}`, { method: 'DELETE' }),
  /**
   * 導向授權頁的網址。
   *
   * **這一個不是 fetch，是給瀏覽器直接開的**（登入是整頁跳轉、綁定是小視窗）——
   * 整段流程要跳出這個站再跳回來，fetch 走不完，而且拿不到對方的登入畫面。
   * 帶了 ticket 就是綁定模式，沒帶就是登入。
   */
  oauthStartUrl: (provider: OauthProviderId, ticket?: string) =>
    `${BASE}/auth/oauth/${provider.toLowerCase()}/start`
    + (ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''),

  projects: () => api<{ projects: Project[] }>('/projects'),
  project: (id: string) =>
    api<Project & {
      statuses: TaskStatus[]
      /** 這個專案自己的優先度與任務類型。畫面上的下拉一律照這兩份，不要寫死 */
      priorities: ProjectParam[]
      types: ProjectParam[]
      members: Array<{ id: string; displayName: string; role: string }>
    }>(`/projects/${id}`),

  // ── 每個專案自己的系統參數（狀態／優先度／任務類型）──
  projectParams: (projectId: string) =>
    api<{ params: ProjectParam[]; canManage: boolean }>(`/projects/${projectId}/parameters`),
  createProjectParam: (projectId: string, json: {
    kind: ParamKind; name: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE'
  }) => api<ProjectParam>(`/projects/${projectId}/parameters`, { method: 'POST', json }),
  /** 改名、改色、改分類，或用 beforeId／afterId 換順序（跟卡片排序同一套 rank） */
  patchProjectParam: (projectId: string, id: string, json: {
    name?: string; color?: string; category?: 'TODO' | 'ACTIVE' | 'DONE'
    beforeId?: string | null; afterId?: string | null
  }) => api<ProjectParam>(`/projects/${projectId}/parameters/${id}`, { method: 'PATCH', json }),
  /** 還有人在用就一定要給 moveTo，把那些任務改到別的值上，不然後端不讓刪 */
  deleteProjectParam: (projectId: string, id: string, moveTo?: string) =>
    api(`/projects/${projectId}/parameters/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`,
        { method: 'DELETE' }),
  createProject: (json: { workspaceId: string; key: string; name: string }) =>
    api<Project>('/projects', { method: 'POST', json }),
  patchProject: (id: string, json: {
    name?: string; description?: string | null; color?: string
    startDate?: string | null; endDate?: string | null; isPublic?: boolean
    /**
     * 專案代碼＝任務編號的前綴（`MRG-2` 的 MRG）。改了之後這個專案所有任務的
     * 編號會立刻跟著換 —— 編號是查詢時用 `key || '-' || number` 拼出來的，
     * 沒有存成欄位，所以不會有新舊不一致的問題。同工作區內不可重複。
     */
    key?: string
  }) => api<Project>(`/projects/${id}`, { method: 'PATCH', json }),

  // ── 成員與加入申請。放人進來只有建立者做得到 ──
  /**
   * 可以找來加進專案的帳號。給了 q 就跨工作區找（比對名字或 email）——
   * 專案管理者要找的人不見得已經在這個工作區裡。
   * 跨工作區搜尋一定要帶 projectId：後端要據此確認你是那個專案的管理者，
   * 否則任何人都能拿 email 一個一個試「這個帳號在不在」。
   */
  workspaceUsers: (workspaceId: string, q = '', projectId = '') =>
    api<{ users: WorkspaceUser[] }>(
      `/workspace-users?${new URLSearchParams({ workspaceId, q, projectId })}`),
  members: (projectId: string) =>
    api<{ members: ProjectMember[]; createdBy: string | null; canManage: boolean }>(
      `/projects/${projectId}/members`),
  addMember: (projectId: string, json: { userId: string; role?: ProjectRole }) =>
    api(`/projects/${projectId}/members`, { method: 'POST', json }),
  setMemberRole: (projectId: string, userId: string, role: ProjectRole) =>
    api(`/projects/${projectId}/members/${userId}`, { method: 'PATCH', json: { role } }),
  removeMember: (projectId: string, userId: string) =>
    api(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
  /**
   * 成員頁：這個人現在手上的任務（不分狀態）與從他手上轉出去的任務。
   * 同專案的人都叫得動 —— 這是「誰在做什麼」，不是管理功能。
   */
  memberTasks: (projectId: string, userId: string) =>
    api<{ current: MemberTask[]; past: PastMemberTask[] }>(
      `/projects/${projectId}/members/${userId}/tasks`),

  /**
   * 要搜尋才回東西（比對專案名稱或代碼）。沒給 q 就只回自己審核中的申請 ——
   * 專案清單不預設攤開來給所有人看，理由見 api/src/routes/members.ts。
   */
  joinableProjects: (workspaceId: string, q = '') =>
    api<{ projects: JoinableProject[] }>(
      `/projects/joinable?${new URLSearchParams({ workspaceId, q })}`),
  applyToJoin: (projectId: string, message?: string) =>
    api<{ id: string }>(`/projects/${projectId}/join-requests`, { method: 'POST', json: { message } }),
  joinRequests: (projectId: string) =>
    api<{ requests: JoinRequest[] }>(`/projects/${projectId}/join-requests`),
  myJoinRequests: () => api<{ requests: MyJoinRequest[] }>('/join-requests/mine'),
  approveJoin: (projectId: string, reqId: string, json: { role?: ProjectRole; note?: string } = {}) =>
    api(`/projects/${projectId}/join-requests/${reqId}/approve`, { method: 'POST', json }),
  rejectJoin: (projectId: string, reqId: string, note?: string) =>
    api(`/projects/${projectId}/join-requests/${reqId}/reject`, { method: 'POST', json: { note } }),
  cancelJoinRequest: (reqId: string) =>
    api(`/join-requests/${reqId}`, { method: 'DELETE' }),

  // ── 請假。同工作區的人都看得到誰請假，備註只有本人與管理者拿得到 ──
  leaves: (workspaceId: string, range?: { from?: string; to?: string }) => {
    const q = new URLSearchParams()
    if (range?.from) q.set('from', range.from)
    if (range?.to) q.set('to', range.to)
    const s = q.toString()
    return api<{ leaves: Leave[]; canManage: boolean }>(
      `/workspaces/${workspaceId}/leaves${s ? `?${s}` : ''}`)
  },
  /** 不給 userId 就是填自己的；填別人的要工作區管理者 */
  createLeave: (workspaceId: string, json: {
    userId?: string; leaveType: LeaveType
    startDate: string; endDate: string; note?: string | null
  }) => api<Leave>(`/workspaces/${workspaceId}/leaves`, { method: 'POST', json }),
  patchLeave: (id: string, json: {
    leaveType?: LeaveType; startDate?: string; endDate?: string; note?: string | null
  }) => api<Leave>(`/leaves/${id}`, { method: 'PATCH', json }),
  deleteLeave: (id: string) => api(`/leaves/${id}`, { method: 'DELETE' }),

  // ── 通知。沒有 WebSocket，前端自己輪詢 ──
  notifications: (limit = 30) =>
    api<{ items: AppNotification[]; unread: number }>(`/notifications?limit=${limit}`),
  markNotificationRead: (id: string) =>
    api<{ unread: number }>(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () =>
    api<{ unread: number }>('/notifications/read-all', { method: 'POST' }),

  // ── 自己的帳號 ──
  myProfile: () =>
    api<{ user: MyProfile; workspaces: Array<{ id: string; name: string; role: WorkspaceRole }> }>(
      '/me/profile'),
  updateProfile: (json: { displayName?: string; email?: string }) =>
    api<{ user: { id: string; email: string; displayName: string } }>(
      '/me/profile', { method: 'PATCH', json }),
  changePassword: (json: { currentPassword: string; newPassword: string }) =>
    api('/me/password', { method: 'POST', json }),

  // ── 自己的 API 權杖。明文只有建立時那一次拿得到 ──
  apiTokens: () => api<{ tokens: ApiToken[] }>('/me/api-tokens'),
  createApiToken: (json: { name: string; expiresOn?: string | null }) =>
    api<{ token: ApiToken; plaintext: string }>('/me/api-tokens', { method: 'POST', json }),
  revokeApiToken: (id: string) => api(`/me/api-tokens/${id}`, { method: 'DELETE' }),

  /** 頭像用 data URL 上傳，前端會先縮到 256 見方（見 components/Avatar.tsx） */
  uploadAvatar: (image: string) =>
    api<{ avatarFile: string }>('/me/avatar', { method: 'PUT', json: { image } }),
  removeAvatar: () => api('/me/avatar', { method: 'DELETE' }),
  /**
   * 頭像的圖檔本身。
   *
   * **不能直接把網址塞進 `<img src>`** —— 那個端點要 Authorization 標頭，
   * 而瀏覽器載入圖片時不會帶，結果一律 401、每個頭像都退回文字色塊。
   * 所以走 fetch 拿 blob，再交給 `<img>`。
   * 另一條路是放寬那個端點的驗證，但頭像是誰的臉，不該變成公開資源。
   */
  avatarBlob: async (userId: string): Promise<Blob> => {
    const headers = new Headers()
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
    const res = await fetch(`${BASE}/users/${userId}/avatar`, { headers, credentials: 'include' })
    if (!res.ok) throw new ApiError(res.status, T.account.avatar.loadFailed)
    return res.blob()
  },

  // ── 工作區管理者：站台上的帳號 ──
  adminUsers: (workspaceId: string) =>
    api<{ users: AdminUser[]; myRole: WorkspaceRole; roles: WorkspaceRole[] }>(
      `/admin/users?workspaceId=${workspaceId}`),
  adminCreateUser: (json: {
    workspaceId: string; email: string; displayName: string
    password: string; role?: WorkspaceRole
  }) => api<{ user: { id: string; email: string; displayName: string } }>(
    '/admin/users', { method: 'POST', json }),
  adminPatchUser: (workspaceId: string, userId: string, json: {
    role?: WorkspaceRole; status?: 'ACTIVE' | 'SUSPENDED'
    displayName?: string; newPassword?: string
  }) => api(`/admin/users/${userId}?workspaceId=${workspaceId}`, { method: 'PATCH', json }),
  /** 回傳的是「轉移了幾個專案」—— 被刪的人開的專案會落到執行刪除的管理者手上 */
  adminDeleteUser: (workspaceId: string, userId: string) =>
    api<{ projectsTransferred: number }>(
      `/admin/users/${userId}?workspaceId=${workspaceId}`, { method: 'DELETE' }),

  // ── 工作區擁有者：他只剩這一件事能做 ──
  adminAdministrators: (workspaceId: string) =>
    api<{ users: AdminCandidate[] }>(`/admin/administrators?workspaceId=${workspaceId}`),
  adminSetAdministrator: (workspaceId: string, userId: string, isAdmin: boolean) =>
    api(`/admin/administrators/${userId}?workspaceId=${workspaceId}`,
        { method: 'PUT', json: { isAdmin } }),

  tasks: (projectId: string, q: Record<string, string> = {}) =>
    api<{ tasks: Task[] }>(`/projects/${projectId}/tasks?${new URLSearchParams(q)}`),
  task: (id: string) => api<TaskDetail>(`/tasks/${id}`),
  createTask: (projectId: string, json: Record<string, unknown>) =>
    api<Task>(`/projects/${projectId}/tasks`, { method: 'POST', json }),
  patchTask: (id: string, json: Record<string, unknown>) =>
    api<Task>(`/tasks/${id}`, { method: 'PATCH', json }),
  moveTask: (id: string, json: { statusKey?: string; beforeId?: string | null; afterId?: string | null; parentId?: string | null }) =>
    api<Task>(`/tasks/${id}/move`, { method: 'POST', json }),
  rescheduleTask: (id: string, json: { startDate: string | null; dueDate: string | null; cascade?: boolean }) =>
    api<{ task: Task; schedule: ScheduleResult }>(`/tasks/${id}/reschedule`, { method: 'POST', json }),
  deleteTask: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
  /**
   * 轉派。跟 `patchTask({ assigneeId })` 分開是為了那句交接說明 ——
   * 換人做的時候，「換成誰」是欄位，「為什麼換、做到哪裡了」是話，
   * 兩者一起寫進活動紀錄，接手的人才看得到來龍去脈。
   * `assigneeId` 給 null 就是收回，不指派給任何人。
   */
  reassignTask: (id: string, json: { assigneeId: string | null; note?: string }) =>
    api<Task>(`/tasks/${id}/reassign`, { method: 'POST', json }),

  schedule: (projectId: string) => api<ScheduleResult>(`/projects/${projectId}/schedule`),

  // ── 儀表板。from／to 不給就由後端算專案的區間 ──
  burndown: (projectId: string, q: { from?: string; to?: string; metric?: DashboardMetric } = {}) =>
    api<BurndownResult>(`/projects/${projectId}/burndown${qs(q)}`),
  workload: (projectId: string, q: { from?: string; to?: string; metric?: DashboardMetric } = {}) =>
    api<WorkloadResult>(`/projects/${projectId}/workload${qs(q)}`),
  graph: (projectId: string) => api<{
    nodes: Array<{ id: string; ref: string; title: string; type: string
                   statusKey: string; progress: number; parentId: string | null
                   inquiryState: InquiryState; problem: string | null }>
    edges: Array<{ id: string; sourceId: string; targetId: string
                   linkType: LinkType; lagDays: number }>
  }>(`/projects/${projectId}/graph`),
  addLink: (taskId: string, json: { targetId: string; linkType: LinkType; lagDays?: number }) =>
    api(`/tasks/${taskId}/links`, { method: 'POST', json }),
  deleteLink: (id: string) => api(`/links/${id}`, { method: 'DELETE' }),

  /** 期望回覆日的預設工作天數（後端環境變數），前端算日期時要跟它一致 */
  inquirySettings: () => api<{ defaultDueDays: number }>('/inquiry-settings'),
  inquiries: (taskId: string) => api<{ inquiries: Inquiry[] }>(`/tasks/${taskId}/inquiries`),
  addInquiry: (taskId: string, json: Record<string, unknown>) =>
    api<Inquiry>(`/tasks/${taskId}/inquiries`, { method: 'POST', json }),
  patchInquiry: (id: string, json: Record<string, unknown>) =>
    api<Inquiry>(`/inquiries/${id}`, { method: 'PATCH', json }),
  markReplied: (id: string, json: Record<string, unknown> = {}) =>
    api<Inquiry>(`/inquiries/${id}/mark-replied`, { method: 'POST', json }),
  reopenInquiry: (id: string) => api<Inquiry>(`/inquiries/${id}/reopen`, { method: 'POST' }),
  deleteInquiry: (id: string) => api(`/inquiries/${id}`, { method: 'DELETE' }),

  unitSuggestions: (workspaceId: string, q = '') =>
    api<{ units: Array<{ unit: string; usageCount: number; lastUsedOn: string }> }>(
      `/workspaces/${workspaceId}/unit-suggestions?q=${encodeURIComponent(q)}`),
  inquiryBoard: (workspaceId: string, state = 'AWAITING,OVERDUE,REPLIED') =>
    api<{ inquiries: Array<Inquiry & {
      taskId: string; taskRef: string; taskTitle: string
      projectId: string; projectName: string; projectColor: string
    }> }>(`/workspaces/${workspaceId}/inquiry-board?state=${state}`),
}
