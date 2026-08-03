import { sql, type Db } from './db.js'

/**
 * 通知的產生端。所有寫入 notification 的地方都走這裡，不要在路由裡自己 INSERT ——
 * 「不通知自己」這條規則只要漏一個地方，使用者就會收到自己做的事。
 *
 * 讀取端在 routes/notifications.ts。
 */

export type NotificationKind =
  | 'TASK_LINKED'
  | 'TASK_ASSIGNED'
  | 'JOIN_REQUESTED'
  | 'JOIN_APPROVED'

export interface NotifyInput {
  /** 交易物件或連線池都可以。有交易的話一定要傳交易，通知不該比事件本身先存在 */
  db: Db
  workspaceId: string
  /** 收件人。null／undefined（例如任務沒有負責人）直接跳過 */
  userId: string | null | undefined
  kind: NotificationKind
  actorId: string
  actorName: string
  projectId?: string | null
  taskId?: string | null
  /** 這種 kind 才需要的細節，前端拿來組句子 */
  body?: Record<string, unknown>
}

export async function notify(n: NotifyInput): Promise<void> {
  // 沒有收件人，或收件人就是動作的人 —— 自己指派給自己、自己關聯自己的任務，
  // 都不該跳通知。這是唯一的過濾點，所以放在這裡而不是各個呼叫端。
  if (!n.userId || n.userId === n.actorId) return

  await n.db`
    INSERT INTO notification
      (workspace_id, user_id, kind, actor_id, actor_name, project_id, task_id, body)
    VALUES
      (${n.workspaceId}, ${n.userId}, ${n.kind}, ${n.actorId}, ${n.actorName},
       ${n.projectId ?? null}, ${n.taskId ?? null},
       ${sql.json((n.body ?? {}) as Record<string, never>)})`
}
