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
}
