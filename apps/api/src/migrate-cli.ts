/**
 * 獨立跑 migration，不啟動伺服器。
 *
 * 用途：升級時先讓 schema 到位，再換 image。這樣「改架構」和「換程式」
 * 是兩個可以分開、分別回滾的動作，不會綁在同一次容器重啟裡。
 *
 *   docker compose run --rm backend npm run migrate
 */
import { sql, migrate } from './lib/db.js'

try {
  const applied = await migrate()
  console.log(applied.length
    ? `已套用 ${applied.length} 個 migration：\n  ${applied.join('\n  ')}`
    : '沒有待套用的 migration，schema 已是最新。')
  await sql.end()
  process.exit(0)
} catch (e) {
  console.error('\n[X] migration 失敗，資料庫未被修改（整份已回滾）：\n')
  console.error(String((e as Error).message))
  await sql.end().catch(() => {})
  process.exit(1)
}
