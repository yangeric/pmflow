import { readdir, readFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { sql } from './db.js'
import { hashPassword } from './auth.js'
import { env } from './env.js'

/**
 * 忘記密碼的最後一把鑰匙：在主機上放一個檔案。
 *
 * **為什麼是檔案而不是端點**：這個站沒有寄信的能力，所以「忘記密碼」平常只能
 * 請管理者代設。但管理者自己進不來的時候就死結了 —— 而自架的站沒有客服可以打。
 * 拿得到主機檔案系統的人本來就等於最高權限，用檔案當 break-glass 不會多開一個
 * 攻擊面；做成 API 端點才會，那等於在網路上留一個永遠開著的後門。
 *
 * **怎麼用**：在 `PMFLOW_PASSWORD_RESET_DIR` 底下放一個檔案
 *   - 檔名：`<email>.reset`，例如 `admin@example.com.reset`
 *   - 內容：新密碼（至少 8 個字元，前後的空白與換行會被去掉）
 *
 * 服務啟動時掃一次，之後每分鐘再掃一次。改完密碼會**立刻刪掉那個檔**、
 * 撤掉那個人所有裝置的登入，並在 log 留一行紀錄 —— 這種操作不能沒有痕跡。
 *
 * **沒設這個環境變數就整組不啟用**。預設不留後門，要用的人得自己打開。
 */

const SUFFIX = '.reset'
const MIN_LENGTH = 8

/** 每分鐘掃一次。放檔的人剛做完不用等太久，但也不值得為它做成即時監看 */
export const RESET_SWEEP_MS = 60_000

export async function sweepPasswordResets(log: FastifyBaseLogger): Promise<void> {
  const dir = env.passwordResetDir
  if (!dir) return

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // 目錄不存在就當作沒啟用。設了變數但還沒建目錄是很正常的狀態，不值得每分鐘噴一次錯
    return
  }

  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue
    // basename 擋掉 readdir 理論上不會回、但不值得相信的東西
    const file = join(dir, basename(name))
    const email = name.slice(0, -SUFFIX.length).trim().toLowerCase()

    let password: string
    try {
      password = (await readFile(file, 'utf8')).trim()
    } catch (e) {
      log.warn({ file, err: e }, '[break-glass] 讀不到重置檔')
      continue
    }

    // 檔案留著讓放檔的人看得到自己哪裡寫錯了 —— 刪掉他只會以為成功了
    if (password.length < MIN_LENGTH) {
      log.warn({ email }, `[break-glass] 重置檔裡的密碼不到 ${MIN_LENGTH} 個字元，先不處理`)
      continue
    }

    const [user] = await sql<{ id: string }[]>`
      SELECT id FROM app_user WHERE lower(email) = ${email}`
    if (!user) {
      log.warn({ email }, '[break-glass] 找不到這個 email 的帳號，先不處理')
      continue
    }

    const hash = await hashPassword(password)
    await sql.begin(async tx => {
      await tx`UPDATE app_user SET password_hash = ${hash} WHERE id = ${user.id}`
      // 密碼被人從主機上換掉了，原本的登入一律作廢
      await tx`UPDATE refresh_token SET revoked_at = now()
               WHERE user_id = ${user.id} AND revoked_at IS NULL`
    })

    // 先改再刪：刪檔失敗總比「檔沒了密碼也沒換」好，下一輪會再處理一次
    try {
      await unlink(file)
    } catch (e) {
      log.error({ file, err: e },
        '[break-glass] 密碼已重置，但重置檔刪不掉，請手動刪除（裡面是明文密碼）')
    }
    log.warn({ email },
      '[break-glass] 有人用主機上的檔案重置了這個帳號的密碼，所有裝置已登出')
  }
}
