import type { Db } from './db.js'
import { conflict } from './errors.js'

export const SCHEDULING_TYPES = ['FS', 'SS', 'FF', 'SF'] as const
export const SEMANTIC_TYPES = ['RELATES', 'BLOCKS', 'DUPLICATES', 'REQUIRES'] as const
export type LinkType = (typeof SCHEDULING_TYPES)[number] | (typeof SEMANTIC_TYPES)[number]

export const isScheduling = (t: string): boolean =>
  (SCHEDULING_TYPES as readonly string[]).includes(t)

/** 對稱型關聯只存一列，用字典序決定方向，從資料層杜絕重複 */
export const SYMMETRIC: ReadonlySet<string> = new Set(['RELATES'])

export const REVERSE_LABEL: Record<LinkType, string> = {
  FS: '被前置', SS: '同時起跑', FF: '同時收尾', SF: '被開始牽制',
  RELATES: '相關', BLOCKS: '被阻擋', DUPLICATES: '被重複', REQUIRES: '被需要',
}

// ─────────────────────────────────────────────────────────
// 階層閉包表
// ─────────────────────────────────────────────────────────

/** 重建某棵子樹的閉包列。新增或搬移任務時，在同一個交易裡呼叫。 */
export async function rebuildClosure(tx: Db, taskId: string): Promise<void> {
  // 先刪掉這棵子樹所有節點「向上」的邊，保留子樹內部的邊
  await tx`
    DELETE FROM task_closure
    WHERE descendant_id IN (SELECT descendant_id FROM task_closure WHERE ancestor_id = ${taskId})
      AND ancestor_id NOT IN (SELECT descendant_id FROM task_closure WHERE ancestor_id = ${taskId})`

  // 自己指向自己（depth 0）
  await tx`
    INSERT INTO task_closure (ancestor_id, descendant_id, depth)
    VALUES (${taskId}, ${taskId}, 0)
    ON CONFLICT DO NOTHING`

  // 新父層的所有祖先 × 這棵子樹的所有後代
  await tx`
    INSERT INTO task_closure (ancestor_id, descendant_id, depth)
    SELECT up.ancestor_id, down.descendant_id, up.depth + down.depth + 1
    FROM task_closure up
    CROSS JOIN task_closure down
    WHERE up.descendant_id = (SELECT parent_id FROM task WHERE id = ${taskId})
      AND down.ancestor_id = ${taskId}
    ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = EXCLUDED.depth`
}

/** 搬移任務到新父層前的檢查：不能搬到自己的後代底下 */
export async function assertNotDescendant(
  tx: Db, taskId: string, newParentId: string | null
): Promise<void> {
  if (!newParentId) return
  if (newParentId === taskId) throw conflict('任務不能成為自己的子任務')
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one FROM task_closure
    WHERE ancestor_id = ${taskId} AND descendant_id = ${newParentId}`
  if (rows.length) throw conflict('不能把任務搬到自己的子任務底下', '這會造成階層循環')
}

// ─────────────────────────────────────────────────────────
// 依賴循環偵測
// ─────────────────────────────────────────────────────────

/**
 * 建立排程類依賴前必須先跑這個。
 *
 * 關鍵：階層邊（parent → child）與依賴邊要**一起**看。
 * 只檢查依賴邊的話，「A 是 B 的父任務，同時 B 又前置於 A」這種混合環會漏掉。
 *
 * 判準：加上 source → target 之後會不會成環，等同於「現在是否已經有一條
 * target → … → source 的路徑」。所以從 target 起步往下走，走得到 source 就是環。
 */
export async function assertNoCycle(
  tx: Db, sourceId: string, targetId: string
): Promise<void> {
  const rows = await tx<{ path: string[] }[]>`
    WITH RECURSIVE edges AS (
      -- 排程類依賴：source 完成/開始 → 影響 target
      SELECT source_id AS from_id, target_id AS to_id
      FROM task_link WHERE link_type IN ('FS','SS','FF','SF')
      UNION ALL
      -- 階層：父任務的日期由子任務彙總，等同一條 child → parent 的邊
      SELECT id AS from_id, parent_id AS to_id
      FROM task WHERE parent_id IS NOT NULL AND deleted_at IS NULL
      UNION ALL
      -- 準備新增的這條邊。方向要跟上面兩種一致（source → target），
      -- 寫反的話從 target 起步第一步就走回 source，任何一條依賴都會被判成環。
      SELECT ${sourceId}::uuid, ${targetId}::uuid
    ),
    walk AS (
      SELECT ${targetId}::uuid AS node, ARRAY[${targetId}::uuid] AS path, 0 AS depth
      UNION ALL
      SELECT e.to_id, w.path || e.to_id, w.depth + 1
      FROM walk w
      JOIN edges e ON e.from_id = w.node
      WHERE NOT e.to_id = ANY(w.path) AND w.depth < 100
    )
    SELECT path::text[] AS path FROM walk WHERE node = ${sourceId}::uuid LIMIT 1`

  if (rows.length) {
    const ids = rows[0].path
    const labels = await tx<{ id: string; label: string }[]>`
      SELECT t.id, p.key || '-' || t.number AS label
      FROM task t JOIN project p ON p.id = t.project_id
      WHERE t.id = ANY(${ids}::uuid[])`
    const byId = new Map(labels.map(l => [l.id, l.label]))
    const cycle = [...ids.map(i => byId.get(i) ?? i), byId.get(ids[0]) ?? ids[0]]
    throw conflict('會造成循環依賴', cycle.join(' → '), { cycle })
  }
}
