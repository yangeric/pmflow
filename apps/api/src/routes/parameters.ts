import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sql, type Db } from '../lib/db.js'
import { authenticate, requireProjectRole, requireProjectManager } from '../lib/auth.js'
import { rankBetween, evenRanks } from '../lib/rank.js'
import { badRequest, notFound } from '../lib/errors.js'
import { countIllegalAfterRetype } from '../lib/hierarchy.js'

/**
 * 每個專案自己的系統參數：任務狀態、優先度、任務類型。
 *
 * **是每個專案改自己的，不是全站一份。** 蓋房子的專案要「圖說審查中」，
 * 辦活動的專案要「等廠商報價」；硬要共用一套只會逼所有人遷就別人的流程。
 * 狀態欄本來就是這樣（task_status），優先度與任務類型原本寫死在 task 的
 * CHECK 裡，0011_project_parameters.sql 把它們也各自拆成一張表。
 *
 * 三種參數共用同一組端點、同一份規則：它們的資料形狀一模一樣
 * （per project + key/name/color/rank），差別只有「狀態多一個 category」與
 * 「任務是用哪一欄指回來的」。分成三組端點的話，改順序、改名、刪除時的
 * 「還有人在用」這些規則要各寫一遍，遲早會有一份忘了跟上。
 *
 * 兩條不能違反的規矩：
 *  1. **key 建立後不可修改。** 任務是靠它指回來的（task.status_key /
 *     task.priority / task.type），改了等於把既有任務指向不存在的值。
 *     名稱、顏色、順序隨時可以改 —— 那些沒有人依賴。
 *  2. **還有任務在用就不准刪。** 要刪就得同時說「那些任務改成哪一個」
 *     （moveTo），伺服器在同一個交易裡搬完才刪。少了這條，畫面上會冒出
 *     一堆指向不存在的值的任務，而且沒有人知道它們原本是什麼。
 */

export const PARAM_KINDS = ['status', 'priority', 'type'] as const
export type ParamKind = (typeof PARAM_KINDS)[number]

export type ParamCategory = 'TODO' | 'ACTIVE' | 'DONE'

export interface ProjectParam {
  id: string
  kind: ParamKind
  key: string
  name: string
  color: string
  rank: number
  /** 只有狀態有：決定它算不算「還沒做完」 */
  category?: ParamCategory
  /** 目前有幾張任務用著它 */
  inUse: number
}

interface RawRow {
  id: string; key: string; name: string; color: string
  rank: number; category?: string; inUse: number
}

interface InsertArgs {
  key: string; name: string; color: string; rank: number; category: ParamCategory
}

interface UpdateArgs {
  name?: string | null; color?: string | null
  category?: ParamCategory | null; rank?: number | null
}

/**
 * 每一種參數各自的四件事：怎麼讀、怎麼寫、怎麼刪、任務是用哪一欄指回來的。
 *
 * **刻意把三份 SQL 攤開寫，不用動態表名。** postgres.js 的 `sql(名稱)` helper
 * 是看「前面那段 SQL 出現過哪個關鍵字」來決定要當成欄位、值還是插入清單處理，
 * 而我們的查詢裡就有 `AS "inUse"` 這種會被它誤判成 `in` 的字串 —— 那會安靜地
 * 產生一段錯誤的 SQL，不會有人在 typecheck 時發現。三份 SQL 多打幾行，
 * 換的是「看得到就是真的送出去的東西」。
 *
 * 其餘的邏輯（排序、重名、還有人在用不准刪）全部只寫一份，共用這張表。
 */
interface KindSpec {
  /** 錯誤訊息裡的稱呼。畫面文案在 web/src/strings/settings.ts，這裡是後端自己的話 */
  label: string
  /** 只有狀態有 category */
  hasCategory: boolean
  /** 整份清單，附上「幾張任務在用」，照 rank 排好 */
  rows(db: Db, projectId: string): Promise<RawRow[]>
  insert(db: Db, projectId: string, v: InsertArgs): Promise<{ id: string }>
  /** 給 null 的欄位一律不動（coalesce） */
  update(db: Db, projectId: string, id: string, v: UpdateArgs): Promise<void>
  remove(db: Db, projectId: string, id: string): Promise<void>
  /** 把還在用舊值的任務全部改到新值 */
  moveTasks(db: Db, projectId: string, fromKey: string, toKey: string): Promise<void>
}

const KIND: Record<ParamKind, KindSpec> = {
  status: {
    label: '任務狀態',
    hasCategory: true,
    rows: (db, projectId) => db<RawRow[]>`
      SELECT x.id, x.key, x.name, x.color, x.category, x.rank::float8 AS rank,
             (SELECT count(*) FROM task t
               WHERE t.project_id = x.project_id
                 AND t.deleted_at IS NULL
                 AND t.status_key = x.key)::int AS "inUse"
      FROM task_status x
      WHERE x.project_id = ${projectId}
      ORDER BY x.rank, x.key`,
    insert: async (db, projectId, v) => {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO task_status (project_id, key, name, category, color, rank)
        VALUES (${projectId}, ${v.key}, ${v.name}, ${v.category}, ${v.color}, ${v.rank})
        RETURNING id`
      return row
    },
    update: async (db, projectId, id, v) => {
      await db`
        UPDATE task_status SET
          name     = coalesce(${v.name ?? null}, name),
          color    = coalesce(${v.color ?? null}, color),
          category = coalesce(${v.category ?? null}, category),
          rank     = coalesce(${v.rank ?? null}, rank)
        WHERE id = ${id} AND project_id = ${projectId}`
    },
    remove: async (db, projectId, id) => {
      await db`DELETE FROM task_status WHERE id = ${id} AND project_id = ${projectId}`
    },
    moveTasks: async (db, projectId, fromKey, toKey) => {
      await db`
        UPDATE task SET status_key = ${toKey}, updated_at = now()
        WHERE project_id = ${projectId} AND deleted_at IS NULL AND status_key = ${fromKey}`
    },
  },

  priority: {
    label: '優先度',
    hasCategory: false,
    rows: (db, projectId) => db<RawRow[]>`
      SELECT x.id, x.key, x.name, x.color, x.rank::float8 AS rank,
             (SELECT count(*) FROM task t
               WHERE t.project_id = x.project_id
                 AND t.deleted_at IS NULL
                 AND t.priority = x.key)::int AS "inUse"
      FROM task_priority x
      WHERE x.project_id = ${projectId}
      ORDER BY x.rank, x.key`,
    insert: async (db, projectId, v) => {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO task_priority (project_id, key, name, color, rank)
        VALUES (${projectId}, ${v.key}, ${v.name}, ${v.color}, ${v.rank})
        RETURNING id`
      return row
    },
    update: async (db, projectId, id, v) => {
      await db`
        UPDATE task_priority SET
          name  = coalesce(${v.name ?? null}, name),
          color = coalesce(${v.color ?? null}, color),
          rank  = coalesce(${v.rank ?? null}, rank)
        WHERE id = ${id} AND project_id = ${projectId}`
    },
    remove: async (db, projectId, id) => {
      await db`DELETE FROM task_priority WHERE id = ${id} AND project_id = ${projectId}`
    },
    moveTasks: async (db, projectId, fromKey, toKey) => {
      await db`
        UPDATE task SET priority = ${toKey}, updated_at = now()
        WHERE project_id = ${projectId} AND deleted_at IS NULL AND priority = ${fromKey}`
    },
  },

  type: {
    label: '任務類型',
    hasCategory: false,
    rows: (db, projectId) => db<RawRow[]>`
      SELECT x.id, x.key, x.name, x.color, x.rank::float8 AS rank,
             (SELECT count(*) FROM task t
               WHERE t.project_id = x.project_id
                 AND t.deleted_at IS NULL
                 AND t.type = x.key)::int AS "inUse"
      FROM task_type x
      WHERE x.project_id = ${projectId}
      ORDER BY x.rank, x.key`,
    insert: async (db, projectId, v) => {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO task_type (project_id, key, name, color, rank)
        VALUES (${projectId}, ${v.key}, ${v.name}, ${v.color}, ${v.rank})
        RETURNING id`
      return row
    },
    update: async (db, projectId, id, v) => {
      await db`
        UPDATE task_type SET
          name  = coalesce(${v.name ?? null}, name),
          color = coalesce(${v.color ?? null}, color),
          rank  = coalesce(${v.rank ?? null}, rank)
        WHERE id = ${id} AND project_id = ${projectId}`
    },
    remove: async (db, projectId, id) => {
      await db`DELETE FROM task_type WHERE id = ${id} AND project_id = ${projectId}`
    },
    moveTasks: async (db, projectId, fromKey, toKey) => {
      await db`
        UPDATE task SET type = ${toKey}, updated_at = now()
        WHERE project_id = ${projectId} AND deleted_at IS NULL AND type = ${fromKey}`
    },
  },
}

// ── 新專案的預設清單 ────────────────────────────────────

/**
 * 優先度與任務類型的預設值。**key 沿用原本寫在 task CHECK 裡的大寫值** ——
 * 任務欄位的預設（'TASK' / 'NORMAL'）指的就是它，換掉會對不上；
 * 既有專案在 0011_project_parameters.sql 也是照這份回填的。
 *
 * 放在這個檔而不是 routes/projects.ts：建立專案要用它，補資料也要用它，
 * 兩邊各留一份的話遲早會有一份沒跟上。projects.ts 直接引這裡。
 * （狀態的預設清單留在 projects.ts 的 DEFAULT_STATUSES，那份從第一天就在那裡。）
 */
export const DEFAULT_PARAMS: Record<'priority' | 'type', InsertArgs[]> = {
  priority: [
    { key: 'LOW',    name: '低',   color: '#94a3b8', rank: 1000, category: 'ACTIVE' },
    { key: 'NORMAL', name: '普通', color: '#3178c6', rank: 2000, category: 'ACTIVE' },
    { key: 'HIGH',   name: '高',   color: '#e07b39', rank: 3000, category: 'ACTIVE' },
    { key: 'URGENT', name: '緊急', color: '#dc2626', rank: 4000, category: 'ACTIVE' },
  ],
  type: [
    { key: 'TASK',      name: '任務',   color: '#3178c6', rank: 1000, category: 'ACTIVE' },
    { key: 'MILESTONE', name: '里程碑', color: '#8b5cf6', rank: 2000, category: 'ACTIVE' },
    // 這裡叫「問題」不叫「缺陷」：他要的是「東西壞了、有人要修」這件事，
    // 「缺陷」是品管的行話，看的人得先翻譯一次。key 維持 BUG 不動 ——
    // 任務是靠 key 指回來的（0012_rename_bug_type.sql 只改既有專案的名稱）。
    { key: 'BUG',       name: '問題',   color: '#dc2626', rank: 3000, category: 'ACTIVE' },
    { key: 'EPIC',      name: '大項目', color: '#d97706', rank: 4000, category: 'ACTIVE' },
  ],
}

/**
 * 一個專案的優先度或任務類型整份都是空的時候，把預設清單補回去。
 *
 * 為什麼需要這個：專案不是只從 POST /projects 生出來的 —— 示範資料
 * （seed.ts）是直接 INSERT 的，而它在 migration 跑完之後才執行，
 * 所以回填那一段撈不到它。少了這道保險，示範專案一打開就是三個空清單，
 * 而且任務會指向根本不存在的值。
 *
 * 只在「整份是空的」時候動作，補的是系統預設值，不會蓋掉任何人改過的東西；
 * ON CONFLICT DO NOTHING 是為了兩個請求同時發現空清單的情況。
 */
export async function fillDefaults(
  db: Db, projectId: string, kind: 'priority' | 'type'
): Promise<void> {
  for (const v of DEFAULT_PARAMS[kind]) {
    if (kind === 'priority') {
      await db`
        INSERT INTO task_priority (project_id, key, name, color, rank)
        VALUES (${projectId}, ${v.key}, ${v.name}, ${v.color}, ${v.rank})
        ON CONFLICT (project_id, key) DO NOTHING`
    } else {
      await db`
        INSERT INTO task_type (project_id, key, name, color, rank)
        VALUES (${projectId}, ${v.key}, ${v.name}, ${v.color}, ${v.rank})
        ON CONFLICT (project_id, key) DO NOTHING`
    }
  }
}

// ── 查詢 ────────────────────────────────────────────────

/** 列出某一種參數。inUse 用子查詢一次算完，不要每一列再回頭問一次資料庫 */
export async function listProjectParams(
  db: Db, projectId: string, kind: ParamKind
): Promise<ProjectParam[]> {
  let rows = await KIND[kind].rows(db, projectId)
  // 空的優先度／任務類型代表這個專案是繞過建立流程生出來的（見 fillDefaults）。
  // 狀態不走這條：它從第一天就有人在建，空的只可能是刻意的。
  if (!rows.length && kind !== 'status') {
    await fillDefaults(db, projectId, kind)
    rows = await KIND[kind].rows(db, projectId)
  }
  return rows.map(r => ({
    id: r.id,
    kind,
    key: r.key,
    name: r.name,
    color: r.color,
    rank: r.rank,
    category: r.category as ParamCategory | undefined,
    inUse: r.inUse,
  }))
}

/** 三種參數合成一個陣列回去，前端自己分組（見 web/src/lib/api.ts 的 ProjectParam） */
async function listAll(db: Db, projectId: string): Promise<ProjectParam[]> {
  const out: ProjectParam[] = []
  for (const kind of PARAM_KINDS) out.push(...await listProjectParams(db, projectId, kind))
  return out
}

/**
 * 這個 id 是哪一種參數。三種共用同一組端點，所以動它之前要先問出來。
 * 順便把整組清單帶回來 —— 後面的重名、排序、還有人在用不准刪都要用到它。
 */
async function findParam(
  db: Db, projectId: string, paramId: string
): Promise<{ kind: ParamKind; self: ProjectParam; siblings: ProjectParam[] } | null> {
  for (const kind of PARAM_KINDS) {
    const siblings = await listProjectParams(db, projectId, kind)
    const self = siblings.find(p => p.id === paramId)
    if (self) return { kind, self, siblings }
  }
  return null
}

/**
 * 寫任務之前用的檢查：這個 key 在這個專案的清單裡存不存在。
 *
 * 資料表上原本的 CHECK 已經拿掉了（合法值跟著 project_id 走，資料表不可能
 * 知道清單長什麼樣），**但拿掉 CHECK 不等於不驗** —— 驗證搬到這裡。
 * 任務的建立與更新改成吃這些清單時，直接呼叫這支（routes/tasks.ts）。
 */
export async function assertParamKey(
  db: Db, projectId: string, kind: ParamKind, key: string
): Promise<void> {
  const rows = await KIND[kind].rows(db, projectId)
  if (!rows.some(r => r.key === key)) {
    throw badRequest(
      `這個專案沒有這個${KIND[kind].label}`,
      `「${key}」不在這個專案的${KIND[kind].label}清單裡。`
      + '請先到專案的系統參數頁把它加進去。')
  }
}

// ── 新增時要用的 key ────────────────────────────────────

/**
 * key 是程式用的，畫面上看不到，但它會出現在 API 的欄位值裡（外部系統靠它
 * 建任務），所以能取得懂就取得懂：名稱是英數就照著轉，是中文就退回
 * 「種類 + 亂數」。反正建立之後不能改，重點是唯一而且穩定。
 */
function keyFromName(name: string): string {
  const ascii = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(ascii) ? ascii.slice(0, 24) : ''
}

function makeKey(taken: Set<string>, kind: ParamKind, name: string): string {
  const base = keyFromName(name)
  if (base && !taken.has(base)) return base
  if (base) {
    for (let i = 2; i < 100; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }
  return `${kind}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

// ── 輸入格式 ────────────────────────────────────────────

const categoryField = z.enum(['TODO', 'ACTIVE', 'DONE'])
const colorField = z.string().regex(/^#[0-9a-fA-F]{6}$/, '顏色要寫成 #rrggbb 這種六碼的形式')
const nameField = z.string().trim().min(1, '名稱不能空白').max(40, '名稱最多 40 個字')

const createBody = z.object({
  kind: z.enum(PARAM_KINDS),
  name: nameField,
  color: colorField.optional(),
  category: categoryField.optional(),
})

const patchBody = z.object({
  name: nameField.optional(),
  color: colorField.optional(),
  category: categoryField.optional(),
  /** 要排在這一列的前面。跟卡片排序同一套（lib/rank.ts） */
  beforeId: z.string().uuid().nullable().optional(),
  /** 要排在這一列的後面 */
  afterId: z.string().uuid().nullable().optional(),
})

const deleteQuery = z.object({
  /** 還有任務在用的話，那些任務要改成哪一個參數 */
  moveTo: z.string().uuid().optional(),
})

/** 反覆對半分會把浮點數的精度用完，這時整組重新配成 1000, 2000, 3000… */
async function rebalance(db: Db, projectId: string, kind: ParamKind): Promise<void> {
  const rows = await KIND[kind].rows(db, projectId)
  const ranks = evenRanks(rows.length)
  for (let i = 0; i < rows.length; i++) {
    await KIND[kind].update(db, projectId, rows[i].id, { rank: ranks[i] })
  }
}

// ── 路由 ────────────────────────────────────────────────

export default async function parameterRoutes(app: FastifyInstance) {

  // ── 讀：專案成員都看得到 ──────────────────────────────
  // 看得到不等於改得了 —— 畫面上的按鈕全掛在 canManage 底下，
  // 而 canManage 是這裡算的，不是前端自己猜的（跟成員頁同一個做法）。
  app.get<{ Params: { id: string } }>('/projects/:id/parameters', async req => {
    const user = await authenticate(req)
    const { role } = await requireProjectRole(user.id, req.params.id, 'VIEWER')
    return {
      params: await listAll(sql, req.params.id),
      canManage: role === 'MANAGER',
    }
  })

  // ── 新增 ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/projects/:id/parameters', async (req, reply) => {
    const user = await authenticate(req)
    await requireProjectManager(user.id, req.params.id)
    const body = createBody.parse(req.body)
    const spec = KIND[body.kind]

    if (body.category && !spec.hasCategory) {
      throw badRequest(
        `${spec.label}沒有「算不算做完了」這個設定`,
        '只有任務狀態需要決定它算不算「還沒做完」。')
    }

    const existing = await KIND[body.kind].rows(sql, req.params.id)
    if (existing.some(r => r.name === body.name)) {
      throw badRequest(
        `已經有一個叫「${body.name}」的${spec.label}`,
        '同一個專案裡不要有兩個同名的值，選單上分不出來。')
    }

    const key = makeKey(new Set(existing.map(r => r.key)), body.kind, body.name)
    // 新的一律排到最後面 —— 順序是人自己調的，不要替他猜
    const rank = existing.reduce((max, r) => Math.max(max, r.rank), 0) + 1000

    const row = await spec.insert(sql, req.params.id, {
      key,
      name: body.name,
      color: body.color ?? '#94a3b8',
      rank,
      category: body.category ?? 'ACTIVE',
    })

    const created = (await listProjectParams(sql, req.params.id, body.kind))
      .find(p => p.id === row.id)
    if (!created) throw notFound('找不到剛剛新增的參數')
    return reply.code(201).send(created)
  })

  // ── 改名、改色、改分類、換順序 ────────────────────────
  // key 刻意不收：任務是靠它指回來的，改了等於把既有任務指向不存在的值。
  app.patch<{ Params: { id: string; paramId: string } }>(
    '/projects/:id/parameters/:paramId', async req => {
      const user = await authenticate(req)
      await requireProjectManager(user.id, req.params.id)
      const b = patchBody.parse(req.body)

      const found = await findParam(sql, req.params.id, req.params.paramId)
      if (!found) throw notFound('找不到這個參數')
      const spec = KIND[found.kind]

      if (b.category && !spec.hasCategory) {
        throw badRequest(
          `${spec.label}沒有「算不算做完了」這個設定`,
          '只有任務狀態需要決定它算不算「還沒做完」。')
      }

      if (b.name && found.siblings.some(p => p.id !== found.self.id && p.name === b.name)) {
        throw badRequest(
          `已經有一個叫「${b.name}」的${spec.label}`,
          '同一個專案裡不要有兩個同名的值，選單上分不出來。')
      }

      // ── 換順序 ──
      // beforeId = 要排在它前面 → 新 rank 落在「它的前一個」與「它」之間，
      // 跟卡片拖曳走同一支 rankBetween（見 routes/tasks.ts 的 /tasks/:id/move）
      let rank: number | null = null
      let needsRebalance = false
      if (b.beforeId || b.afterId) {
        const rankOf = (id: string | null | undefined): number | null => {
          if (!id) return null
          // 鄰居一定要是同一種參數 —— 三種共用端點，傳錯組別的話
          // 算出來的 rank 會把兩組的順序攪在一起
          const n = found.siblings.find(p => p.id === id)
          if (!n) {
            throw badRequest('排序的位置不對', `只能排在同一組${spec.label}裡面。`)
          }
          return n.rank
        }
        const r = rankBetween(rankOf(b.afterId), rankOf(b.beforeId))
        rank = r.rank
        needsRebalance = r.needsRebalance
      }

      await sql.begin(async tx => {
        await spec.update(tx, req.params.id, req.params.paramId, {
          name: b.name,
          color: b.color,
          category: spec.hasCategory ? b.category : null,
          rank,
        })
        if (needsRebalance) await rebalance(tx, req.params.id, found.kind)
      })

      const updated = (await listProjectParams(sql, req.params.id, found.kind))
        .find(p => p.id === req.params.paramId)
      if (!updated) throw notFound('找不到這個參數')
      return updated
    })

  // ── 刪除 ──────────────────────────────────────────────
  /**
   * 還有任務在用就一定要給 moveTo。
   *
   * 不做「連同任務一起刪」也不做「留著指向不存在的值」：前者是拿刪一個選項
   * 的動作去刪別人的工作，後者會讓那些任務在清單與看板上變成空白，而且
   * 沒有人記得它們原本是什麼。搬移與刪除在同一個交易裡，中途失敗兩件事都不會發生。
   */
  app.delete<{
    Params: { id: string; paramId: string }
    Querystring: Record<string, string>
  }>('/projects/:id/parameters/:paramId', async (req, reply) => {
    const user = await authenticate(req)
    await requireProjectManager(user.id, req.params.id)
    const { moveTo } = deleteQuery.parse(req.query)

    const found = await findParam(sql, req.params.id, req.params.paramId)
    if (!found) throw notFound('找不到這個參數')
    const { kind, self, siblings } = found
    const spec = KIND[kind]

    // 全部刪光的話，任務就沒有任何值可以選了
    if (siblings.length <= 1) {
      throw badRequest(
        `至少要留一個${spec.label}`,
        `這是這個專案唯一的${spec.label}，刪掉之後任務就沒有值可以選了。`)
    }

    if (self.inUse > 0 && !moveTo) {
      throw badRequest(
        `還有 ${self.inUse} 張任務正在使用「${self.name}」`,
        `要刪掉它，請先指定那些任務要改成哪一個${spec.label}。`)
    }

    let targetKey: string | null = null
    if (moveTo) {
      if (moveTo === req.params.paramId) {
        throw badRequest('不能改成它自己', `請挑一個別的${spec.label}。`)
      }
      const target = siblings.find(p => p.id === moveTo)
      if (!target) {
        throw badRequest(
          '找不到要改成的那個值',
          `那些任務只能改成同一個專案裡的其他${spec.label}。`)
      }
      targetKey = target.key

      /*
       * 刪掉一種任務種類時，那些任務會被整批改成另一種 —— 那條路一次改幾十張，
       * 一張一張建立時擋的種類上下關係（lib/hierarchy.ts）在這裡完全繞得過去：
       * 把一整批任務改成「大項目」的話，它們原本掛著的位置立刻全部不合法。
       *
       * 所以搬之前先問一句「搬完會不會有人違規」。有的話整筆擋下來，
       * 並且點名幾張 —— 只說「不行」的話，他得自己一張一張猜是哪幾張卡住。
       * 這裡不自動幫他搬位置：那等於在他沒看到的地方動他的階層。
       */
      if (kind === 'type') {
        const bad = await countIllegalAfterRetype(sql, req.params.id, self.key, targetKey)
        if (bad > 0) {
          throw badRequest(
            `有 ${bad} 張任務改成「${target.name}」之後會放錯位置`,
            '大項目只能放在最上層或另一個大項目底下；問題一定要掛在一張任務底下。'
            + '請先把那些任務搬到合適的上層，或改成別的種類，再回來刪。')
        }
      }
    }

    await sql.begin(async tx => {
      if (targetKey) await spec.moveTasks(tx, req.params.id, self.key, targetKey)
      await spec.remove(tx, req.params.id, req.params.paramId)
    })

    return reply.code(204).send()
  })
}
