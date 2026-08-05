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

  projects: () => api<{ projects: Project[] }>('/projects'),
  project: (id: string) =>
    api<Project & { statuses: TaskStatus[]; members: Array<{ id: string; displayName: string; role: string }> }>(`/projects/${id}`),
  createProject: (json: { workspaceId: string; key: string; name: string }) =>
    api<Project>('/projects', { method: 'POST', json }),
  patchProject: (id: string, json: {
    name?: string; description?: string | null; color?: string
    startDate?: string | null; endDate?: string | null; isPublic?: boolean
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
  /** 頭像的網址。檔名帶時間戳，換過就是新網址，不會拿到快取的舊圖 */
  avatarUrl: (userId: string, version?: string | null) =>
    `/api/v1/users/${userId}/avatar${version ? `?v=${encodeURIComponent(version)}` : ''}`,

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

  schedule: (projectId: string) => api<ScheduleResult>(`/projects/${projectId}/schedule`),
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
