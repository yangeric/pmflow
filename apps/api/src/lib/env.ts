import { randomBytes } from 'node:crypto'

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`缺少必要環境變數：${name}`)
  return v
}

const isProd = process.env.NODE_ENV === 'production'

// 開發時沒設 JWT_SECRET 就自動產一組（重啟後 token 失效，這是刻意的）。
// 生產環境一定要自己設，沒設就直接讓服務起不來，不要默默用隨機值。
function jwtSecret(): string {
  const v = process.env.PMFLOW_JWT_SECRET
  if (v && v.length >= 32) return v
  if (isProd) {
    throw new Error(
      'PMFLOW_JWT_SECRET 未設定或長度不足 32 字元。請用 `openssl rand -base64 48` 產生。'
    )
  }
  const generated = randomBytes(48).toString('base64')
  console.warn('[env] 未設定 PMFLOW_JWT_SECRET，開發模式自動產生一組（重啟後所有登入失效）')
  return generated
}

/**
 * Apple 的簽章金鑰（.p8）。
 *
 * 環境變數塞不下換行，所以兩種寫法都收：
 *   1. 整份 PEM，換行用字面上的 `\n`（docker-compose 的 YAML 裡最好寫）
 *   2. 整份 PEM 再 base64 一次（貼進 NAS 的網頁介面時不會被吃掉換行）
 *
 * **金鑰只從環境變數來，不准落到 repo 裡** —— Apple 的 .p8 下載後就再也拿不到
 * 第二次，外流等於別人可以冒充這個站跟 Apple 換權杖。
 */
function applePrivateKey(): string {
  const raw = (process.env.PMFLOW_APPLE_PRIVATE_KEY ?? '').trim()
  if (!raw) return ''
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n')
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return decoded.includes('BEGIN') ? decoded : ''
  } catch { return '' }
}

export const env = {
  isProd,
  port: Number(req('PORT', '8080')),
  host: req('HOST', '0.0.0.0'),
  databaseUrl: req('DATABASE_URL', 'postgres://pmflow:pmflow@localhost:5432/pmflow'),
  jwtSecret: jwtSecret(),
  accessTtlSec: Number(req('PMFLOW_ACCESS_TTL_SEC', '900')),      // 15 分鐘
  refreshTtlSec: Number(req('PMFLOW_REFRESH_TTL_SEC', '604800')), // 7 天
  allowSelfRegistration: req('PMFLOW_ALLOW_SELF_REGISTRATION', 'true') !== 'false',
  allowedEmailDomains: req('PMFLOW_ALLOWED_EMAIL_DOMAINS', '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  corsOrigin: req('PMFLOW_CORS_ORIGIN', 'http://localhost:5173'),
  inquiryDefaultDueDays: Number(req('PMFLOW_INQUIRY_DEFAULT_DUE_DAYS', '7')),
  seedDemo: req('PMFLOW_SEED_DEMO', 'true') !== 'false',
  /** 上傳的檔案放這裡。容器把它掛成 volume，換版本不會把圖弄丟 */
  attachmentsDir: req('PMFLOW_ATTACHMENTS_DIR', '/data/attachments'),
  /**
   * 從主機上重置密碼用的目錄（見 lib/breakglass.ts）。
   * **預設空字串＝整組關掉**，要用的人自己開 —— 這是 break-glass，不是常設功能。
   */
  passwordResetDir: req('PMFLOW_PASSWORD_RESET_DIR', '').trim(),

  /**
   * 這個站**從外面看**的網址（含 scheme，結尾不要斜線），例如 `https://pm.example.com`。
   *
   * 只有 Google／Apple 登入需要它：callback 網址必須跟申請時登記的一模一樣，
   * 而後端看不到使用者是從哪個網址進來的（前面還有反向代理）。
   * **沒設就等於整組 Google／Apple 登入關掉** —— 猜一個網址出來只會換到
   * 「redirect_uri_mismatch」，那比沒有這個功能更難查。
   */
  publicUrl: req('PMFLOW_PUBLIC_URL', '').trim().replace(/\/+$/, ''),

  /**
   * Google／Apple 綁定登入。**全部留空是正常狀態**：自架的人要自己去
   * Google Cloud Console／Apple Developer 申請，沒填齊的那一家就不會出現在登入頁上
   * （見 lib/oauth.ts 的 isProviderConfigured）。
   */
  oauth: {
    google: {
      clientId: req('PMFLOW_GOOGLE_CLIENT_ID', '').trim(),
      clientSecret: req('PMFLOW_GOOGLE_CLIENT_SECRET', '').trim(),
    },
    apple: {
      /** Apple 的 Services ID（不是 App ID），長得像 com.example.pmflow.web */
      clientId: req('PMFLOW_APPLE_CLIENT_ID', '').trim(),
      teamId: req('PMFLOW_APPLE_TEAM_ID', '').trim(),
      keyId: req('PMFLOW_APPLE_KEY_ID', '').trim(),
      privateKey: applePrivateKey(),
    },
  },
}
