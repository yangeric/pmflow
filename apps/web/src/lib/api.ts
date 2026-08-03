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
}

export type ProjectRole = 'MANAGER' | 'EDITOR' | 'COMMENTER' | 'VIEWER'

/** 同工作區的帳號，給建立者挑人加進專案用 */
export interface WorkspaceUser {
  id: string; displayName: string; email: string; role: string
}

/** 工作區層級的角色。跟專案角色（ProjectRole）是兩回事 */
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'

export interface MyProfile {
  id: string; email: string; displayName: string
  locale: string; timezone: string; createdAt: string
}

/** 管理者看到的帳號一覽 */
export interface AdminUser {
  id: string; email: string; displayName: string
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED'
  role: WorkspaceRole; joinedAt: string
  projectCount: string; createdCount: string
}

export interface ProjectMember {
  id: string; displayName: string; email: string
  role: ProjectRole; joinedAt: string; isCreator: boolean
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
  type: 'TASK' | 'MILESTONE' | 'BUG' | 'EPIC'
  statusKey: string; priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  assigneeId: string | null; assigneeName: string | null
  startDate: string | null; dueDate: string | null
  estimateHours: string | null; progress: number
  scheduleMode: 'AUTO' | 'MANUAL'; rank: string
  inquiryState: InquiryState; earliestDueDate: string | null
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

  // ── 成員與加入申請。放人進來只有建立者做得到 ──
  workspaceUsers: (workspaceId: string) =>
    api<{ users: WorkspaceUser[] }>(`/workspace-users?workspaceId=${workspaceId}`),
  members: (projectId: string) =>
    api<{ members: ProjectMember[]; createdBy: string | null; canManage: boolean }>(
      `/projects/${projectId}/members`),
  addMember: (projectId: string, json: { userId: string; role?: ProjectRole }) =>
    api(`/projects/${projectId}/members`, { method: 'POST', json }),
  setMemberRole: (projectId: string, userId: string, role: ProjectRole) =>
    api(`/projects/${projectId}/members/${userId}`, { method: 'PATCH', json: { role } }),
  removeMember: (projectId: string, userId: string) =>
    api(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

  joinableProjects: (workspaceId: string) =>
    api<{ projects: JoinableProject[] }>(`/projects/joinable?workspaceId=${workspaceId}`),
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
                   inquiryState: InquiryState }>
    edges: Array<{ id: string; sourceId: string; targetId: string
                   linkType: LinkType; lagDays: number }>
  }>(`/projects/${projectId}/graph`),
  addLink: (taskId: string, json: { targetId: string; linkType: LinkType; lagDays?: number }) =>
    api(`/tasks/${taskId}/links`, { method: 'POST', json }),
  deleteLink: (id: string) => api(`/links/${id}`, { method: 'DELETE' }),

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
  inquiryStats: (workspaceId: string) =>
    api<{
      byUnit: Array<{ unit: string; totalAsked: number; totalReplied: number
        currentOverdue: number; avgDaysToReply: string | null; lateReplyRate: string | null }>
      transferred: Array<{ askedToUnit: string; repliedByUnit: string; count: number }>
    }>(`/workspaces/${workspaceId}/inquiry-stats`),
}
