import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { env } from './env.js'
import { badRequest } from './errors.js'

/**
 * 頭像的存取。
 *
 * **刻意不引進 multipart 套件**：上傳一張頭像用 JSON 帶 data URL 就夠了，
 * 為此多一個相依、多一組解析路徑、多一種要防的攻擊面並不划算
 * （這個專案的相依有授權白名單關卡，能不加就不加）。
 *
 * 圖檔放檔案系統，資料庫只記檔名 —— 見 migration 0005 的說明。
 */

/** 只收這三種。副檔名不算數，看的是檔頭那幾個位元組 */
const TYPES = [
  { ext: 'png',  mime: 'image/png',  magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg',  mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },   // RIFF....WEBP
] as const

/** 2MB。前端會先縮到 256px 見方，正常情況遠小於這個數字 */
const MAX_BYTES = 2 * 1024 * 1024

const dir = () => join(env.attachmentsDir, 'avatars')

/**
 * 認檔頭，不認副檔名也不認 data URL 上寫的 mime ——
 * 那兩個都是上傳的人說了算，把 .png 換成別的東西一樣送得進來。
 */
function sniff(buf: Buffer) {
  const t = TYPES.find(t => t.magic.every((b, i) => buf[i] === b))
  if (!t) throw badRequest('只接受 PNG、JPEG 或 WebP 圖檔')
  if (t.ext === 'webp' && buf.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw badRequest('只接受 PNG、JPEG 或 WebP 圖檔')
  }
  return t
}

/** data URL → 檔案，回傳存起來的檔名 */
export async function saveAvatar(userId: string, dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma < 0) throw badRequest('圖片格式不正確')
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  if (!buf.length) throw badRequest('圖片是空的')
  if (buf.length > MAX_BYTES) throw badRequest('圖片太大，請控制在 2MB 以內')

  const { ext } = sniff(buf)
  // 檔名帶時間戳：換頭像時檔名跟著變，瀏覽器與快取不會還抱著舊圖
  const file = `${userId}-${Date.now()}.${ext}`
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), file), buf)
  return file
}

export async function readAvatar(file: string) {
  // basename：資料庫的值理論上是我們自己寫進去的，但讀檔前一律再擋一次
  // ../ 之類的東西 —— 這種地方不留「應該不會」的空間
  const safe = basename(file)
  const t = TYPES.find(t => safe.endsWith('.' + t.ext))
  if (!t) return null
  try {
    return { body: await readFile(join(dir(), safe)), mime: t.mime }
  } catch {
    return null      // 檔案不見了（換過機器、volume 沒掛）就當作沒有頭像
  }
}

/** 換頭像或移除時把舊檔刪掉。刪不掉不算錯 —— 資料已經改好，殘檔不影響任何人 */
export async function removeAvatar(file: string | null): Promise<void> {
  if (!file) return
  await unlink(join(dir(), basename(file))).catch(() => {})
}
