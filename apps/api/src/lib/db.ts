import postgres from 'postgres'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'

export const sql = postgres(env.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  onnotice: () => {},           // migration 的 NOTICE 不用洗版
  transform: { undefined: null },
})

/** 同時接受連線池與交易物件 —— helper 兩種情境都會被呼叫 */
export type Db = typeof sql | postgres.TransactionSql<Record<string, never>>
export type Sql = Db

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Migration runner —— 這裡的規矩是「資料跟架構脫離」的實作基礎。
 *
 * 核心前提：**資料庫是長期資產，程式是可替換的。** 換 image、回滾版本、
 * 甚至整個後端改寫成 Java，資料都不該受影響。所以這支 runner 守三件事：
 *
 *  1. **只加不改（append-only）**：已套用的 migration 檔存 checksum，
 *     內容被改過就開機失敗。否則同一個檔名在兩台機器上會長成不同的 schema，
 *     而且沒有人會發現。
 *  2. **一次只有一個人在改 schema**：整個流程包在 advisory lock 裡。
 *     NAS 重開或多容器同時啟動時，第二個會等，不會兩邊搶著跑 DDL。
 *  3. **全有或全無**：所有待跑的 migration 在同一個交易裡完成，
 *     中途失敗整份回滾，不會留下半套 schema 讓系統處於未知狀態。
 *
 * 搭配的紀律寫在 docs/MIGRATIONS.md（expand-contract：加欄位 → 雙寫 →
 * 回填 → 換讀取 → 很久以後才刪舊欄位），讓新舊版程式能同時對著同一個
 * 資料庫運作，升級與回滾都不會掉資料。
 */
const MIGRATION_LOCK = 8_931_477   // 隨便挑的常數，只要全專案一致就好

export async function migrate(): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   text PRIMARY KEY,
      checksum   text,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_ms integer
    )`
  // 從舊版升上來的資料庫可能還沒有這幾欄
  await sql`ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS checksum text`
  await sql`ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS applied_ms integer`

  // 開發用 tsx 跑 src/，正式用 node 跑 dist/，兩邊都找得到
  const dirs = [join(here, '..', 'migrations'), join(here, '..', '..', 'src', 'migrations')]
  let dir = dirs[0]
  let files: string[] = []
  for (const d of dirs) {
    try {
      files = (await readdir(d)).filter(f => f.endsWith('.sql')).sort()
      if (files.length) { dir = d; break }
    } catch { /* 換下一個 */ }
  }
  if (!files.length) throw new Error('找不到任何 migration 檔')

  const bodies = new Map<string, string>()
  for (const f of files) bodies.set(f, await readFile(join(dir, f), 'utf8'))

  const applied: string[] = []

  await sql.begin(async tx => {
    // 只有一個人能改 schema。交易結束自動釋放，不會卡死。
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`

    // 拿鎖之後才讀狀態，否則會用到別人剛改完之前的舊快照
    const rows = await tx<{ filename: string; checksum: string | null }[]>`
      SELECT filename, checksum FROM schema_migration`
    const done = new Map(rows.map(r => [r.filename, r.checksum]))

    // ── 守則一：已套用的檔案不准被改 ──
    for (const [f, recorded] of done) {
      const body = bodies.get(f)
      if (body === undefined) {
        throw new Error(
          `migration ${f} 已套用但檔案不見了。` +
          `不要刪除已發佈的 migration —— 資料庫回不去，新機器也建不起來。`)
      }
      const now = sha256(body)
      if (recorded === null) {
        // 舊版沒存 checksum，這次補登記
        await tx`UPDATE schema_migration SET checksum = ${now} WHERE filename = ${f}`
      } else if (recorded !== now) {
        throw new Error(
          `migration ${f} 的內容在套用之後被修改了（checksum 不符）。\n` +
          `已發佈的 migration 一律只加不改：請新增一個 migration 來修正，` +
          `不要改舊的 —— 否則已經升級過的資料庫不會重跑，兩邊 schema 會悄悄分岔。`)
      }
    }

    const pending = files.filter(f => !done.has(f))
    if (!pending.length) return

    // ── 守則二：不接受插隊的 migration ──
    // 有人從舊分支帶回一個編號較小的檔案時，不同機器套用順序會不一致
    const maxApplied = [...done.keys()].sort().pop()
    if (maxApplied) {
      const outOfOrder = pending.filter(f => f < maxApplied)
      if (outOfOrder.length && process.env.PMFLOW_ALLOW_OUT_OF_ORDER_MIGRATION !== 'true') {
        throw new Error(
          `偵測到插隊的 migration：${outOfOrder.join(', ')}（已套用到 ${maxApplied}）。\n` +
          `請把檔案重新編號到最後面。確定要放行就設 PMFLOW_ALLOW_OUT_OF_ORDER_MIGRATION=true。`)
      }
    }

    // ── 守則三：全有或全無 ──
    for (const f of pending) {
      const t0 = Date.now()
      await tx.unsafe(bodies.get(f)!)
      await tx`
        INSERT INTO schema_migration (filename, checksum, applied_ms)
        VALUES (${f}, ${sha256(bodies.get(f)!)}, ${Date.now() - t0})`
      applied.push(f)
    }
  })

  return applied
}

const sha256 = (s: string) =>
  createHash('sha256').update(s.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 32)
