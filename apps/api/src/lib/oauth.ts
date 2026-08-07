import { randomBytes, createHash } from 'node:crypto'
import {
  SignJWT, jwtVerify, createRemoteJWKSet, importPKCS8, decodeJwt,
} from 'jose'
import { env } from './env.js'
import { badRequest } from './errors.js'

/**
 * 用 Google／Apple 的帳號登入 —— 協定那一層。
 *
 * 這個檔只做「跟對方講話」：組授權網址、拿授權碼換權杖、驗那張 id_token。
 * 「換到的人是誰、要開新帳號還是綁到既有帳號」是產品規則，在 routes/oauth.ts。
 *
 * **沒有引入任何新的相依。** jose（MIT）本來就在用來簽自家的 access token，
 * 它同時做得到驗別人的 id_token（createRemoteJWKSet 會自己抓、自己快取公鑰）
 * 與簽 Apple 要的 ES256 client secret。市面上的 OAuth 客戶端函式庫大多會再拖
 * 一串相依進來，對一個要過授權白名單的 MIT 專案來說不划算。
 *
 * 安全上守的四件事：
 *  1. **state 綁瀏覽器**：state 是我們自己簽的 JWT，裡面放一段亂數的雜湊，
 *     亂數本體放在 httpOnly cookie。第三方誘導出來的 callback 沒有那個 cookie，
 *     對不起來就直接拒絕（CSRF）。
 *  2. **nonce 綁這一次流程**：nonce 放進 state，回來時比對 id_token 裡的 nonce，
 *     擋掉把別處攔到的 id_token 重放進來。
 *  3. **id_token 一定驗簽**，並檢查 iss / aud / exp（jwtVerify 一起做掉）。
 *     只解不驗等於讓任何人自己造一張 token 說「我是某某某」。
 *  4. **Apple 的 client secret 是現算的 JWT**，用 .p8 私鑰當場簽，
 *     金鑰只從環境變數來，不落地、不進 repo。
 */

export const PROVIDERS = ['GOOGLE', 'APPLE'] as const
export type ProviderId = (typeof PROVIDERS)[number]

/** 網址上用小寫（/auth/oauth/google/...），資料庫與程式裡用大寫 */
export function toProviderId(s: string): ProviderId | null {
  const up = s.toUpperCase()
  return (PROVIDERS as readonly string[]).includes(up) ? (up as ProviderId) : null
}

/** 講給人聽的名字。畫面上與錯誤訊息都用這個，不要出現 provider 代碼 */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  GOOGLE: 'Google',
  APPLE: 'Apple',
}

interface ProviderMeta {
  authorizeUrl: string
  tokenUrl: string
  jwksUrl: string
  issuer: string
  scope: string
  /**
   * Apple 一旦要 name／email 就強制 form_post（他們用 POST 把結果送回來）。
   * Google 用預設的 query 就好 —— 少一次跨站 POST 少一種 cookie 問題。
   */
  formPost: boolean
}

/**
 * 端點寫死不打 discovery（/.well-known/openid-configuration）。
 * 這兩家的網址十年沒動過，而每次登入多一次對外請求，
 * 在內網自架、對外連線受限的環境裡只會多一個會壞的地方。
 */
const META: Record<ProviderId, ProviderMeta> = {
  GOOGLE: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: 'https://accounts.google.com',
    scope: 'openid email profile',
    formPost: false,
  },
  APPLE: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    scope: 'name email',
    formPost: true,
  },
}

/** 每家的 client id。Apple 用的是 Services ID，不是 App ID */
export const clientId = (p: ProviderId): string =>
  p === 'GOOGLE' ? env.oauth.google.clientId : env.oauth.apple.clientId

/**
 * 這一家設定齊了沒有。
 *
 * `publicUrl` 也算在內：callback 網址是拿它拼出來的，沒有它連授權網址都組不出來。
 * 沒齊的那一家**登入頁不會畫按鈕**，端點也會回一句看得懂的話（不是 500）。
 */
export function isProviderConfigured(p: ProviderId): boolean {
  if (!env.publicUrl) return false
  if (p === 'GOOGLE') {
    return !!(env.oauth.google.clientId && env.oauth.google.clientSecret)
  }
  const a = env.oauth.apple
  return !!(a.clientId && a.teamId && a.keyId && a.privateKey)
}

export const configuredProviders = (): ProviderId[] => PROVIDERS.filter(isProviderConfigured)

/** 設定不齊時到底缺什麼，只回給呼叫端點的人看（不會出現在登入頁上） */
export function assertConfigured(p: ProviderId): void {
  if (isProviderConfigured(p)) return
  const label = PROVIDER_LABEL[p]
  if (!env.publicUrl) {
    throw badRequest(
      `這個站還沒有啟用「用 ${label} 帳號登入」`,
      '尚未設定站台的對外網址（PMFLOW_PUBLIC_URL），callback 網址組不出來。' +
      '設定步驟見 README。')
  }
  throw badRequest(
    `這個站還沒有啟用「用 ${label} 帳號登入」`,
    p === 'GOOGLE'
      ? '缺少 PMFLOW_GOOGLE_CLIENT_ID 或 PMFLOW_GOOGLE_CLIENT_SECRET。設定步驟見 README。'
      : '缺少 PMFLOW_APPLE_CLIENT_ID／TEAM_ID／KEY_ID／PRIVATE_KEY 其中之一。設定步驟見 README。')
}

/**
 * callback 網址。**跟申請時登記的必須一字不差**，
 * 所以它是從 PMFLOW_PUBLIC_URL 拼出來的，不從請求標頭猜 ——
 * 前面有反向代理時 Host 標頭不見得是使用者看到的那個網址。
 */
export const redirectUri = (p: ProviderId): string =>
  `${env.publicUrl}/api/v1/auth/oauth/${p.toLowerCase()}/callback`

// ── state：綁瀏覽器、綁這一次流程 ──────────────────────────

const stateKey = new TextEncoder().encode(env.jwtSecret)

/** state 的有效期。使用者在對方的頁面上磨蹭太久就重按一次，比放寬到一小時安全 */
const STATE_TTL = '10m'

/** 綁定流程用的一次性入場券：從已登入的頁面換出來，只活 60 秒 */
const LINK_TICKET_TTL = '60s'

export type OauthMode = 'login' | 'link'

export interface OauthState {
  provider: ProviderId
  mode: OauthMode
  /** 綁定模式才有：要把這個身分綁到誰身上 */
  userId?: string
  nonce: string
  /** cookie 裡那段亂數的雜湊。對不起來就是別人誘導出來的 callback */
  cookieHash: string
}

/** cookie 與 state 是一組的：cookie 存亂數本體，state 存它的雜湊 */
export function newStateSecret() {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: createHash('sha256').update(raw).digest('hex') }
}

export const hashStateSecret = (raw: string) =>
  createHash('sha256').update(raw).digest('hex')

export async function signState(s: OauthState): Promise<string> {
  return new SignJWT({
    p: s.provider, m: s.mode, u: s.userId, n: s.nonce, c: s.cookieHash,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(STATE_TTL)
    .sign(stateKey)
}

export async function verifyState(token: string): Promise<OauthState> {
  // 簽章錯、過期、根本不是 JWT，都會從 jwtVerify 丟出來。不接的話使用者看到的
  // 會是一句什麼都沒講的「登入沒有完成」，連是不是自己在頁面上放太久都不知道
  const payload = await jwtVerify(token, stateKey).then(r => r.payload).catch(() => {
    throw badRequest(
      '這次登入的識別碼已失效，請重新登入一次',
      '授權頁面停留超過 10 分鐘，或這個連結不是從登入頁按出來的。')
  })
  const provider = toProviderId(String(payload.p ?? ''))
  if (!provider) throw badRequest('登入流程的識別碼不正確，請重新登入一次')
  return {
    provider,
    mode: payload.m === 'link' ? 'link' : 'login',
    userId: payload.u ? String(payload.u) : undefined,
    nonce: String(payload.n ?? ''),
    cookieHash: String(payload.c ?? ''),
  }
}

export async function signLinkTicket(userId: string): Promise<string> {
  return new SignJWT({ purpose: 'oauth-link' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(LINK_TICKET_TTL)
    .sign(stateKey)
}

export async function verifyLinkTicket(ticket: string): Promise<string> {
  const payload = await jwtVerify(ticket, stateKey).then(r => r.payload).catch(() => {
    throw badRequest(
      '這張綁定用的憑證已失效，請回到帳號設定再按一次',
      '它只有 60 秒的有效期，這樣就算網址被記進日誌也拿不來做別的事。')
  })
  if (payload.purpose !== 'oauth-link' || !payload.sub) {
    throw badRequest('這張綁定用的憑證不正確，請回到帳號設定再按一次')
  }
  return payload.sub
}

export const newNonce = () => randomBytes(16).toString('base64url')

// ── 導向授權頁 ─────────────────────────────────────────────

export function authorizeUrl(p: ProviderId, state: string, nonce: string): string {
  const meta = META[p]
  const q = new URLSearchParams({
    client_id: clientId(p),
    redirect_uri: redirectUri(p),
    response_type: 'code',
    scope: meta.scope,
    state,
    nonce,
  })
  // Apple 要 name／email 就一定得 form_post，用 query 會直接被拒
  if (meta.formPost) q.set('response_mode', 'form_post')
  // 沒有這行的話，機器上已經登入某個 Google 帳號時會直接跳過選擇畫面，
  // 想綁另一個帳號的人會綁到錯的那個而且完全看不出來
  if (p === 'GOOGLE') q.set('prompt', 'select_account')
  return `${meta.authorizeUrl}?${q}`
}

export const usesFormPost = (p: ProviderId): boolean => META[p].formPost

// ── Apple 的 client secret：現算的 ES256 JWT ─────────────────

/**
 * Apple 不發固定的 client secret，要拿 .p8 私鑰自己簽一張 JWT。
 *
 * 規格允許最長 **6 個月**，但這裡每次換權杖都當場簽一張、只給 5 分鐘 ——
 * 反正簽一次不到 1 毫秒，而短命的憑證就算被記進某個代理伺服器的日誌也沒有價值。
 * 存一張半年的在記憶體或資料庫裡，只會換來「到期那天整組登入壞掉」這種
 * 半年才踩一次、踩到時沒有人記得為什麼的問題。
 */
async function appleClientSecret(): Promise<string> {
  const a = env.oauth.apple
  const key = await importPKCS8(a.privateKey, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: a.keyId })
    .setIssuer(a.teamId)
    .setSubject(a.clientId)          // sub 是 Services ID，不是使用者
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')         // 規格上限 6 個月，我們刻意只給 5 分鐘
    .sign(key)
}

const clientSecret = async (p: ProviderId): Promise<string> =>
  p === 'GOOGLE' ? env.oauth.google.clientSecret : appleClientSecret()

// ── 授權碼換權杖 ───────────────────────────────────────────

interface TokenResponse {
  id_token?: string
  access_token?: string
  error?: string
  error_description?: string
}

export async function exchangeCode(p: ProviderId, code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(p),
    client_id: clientId(p),
    client_secret: await clientSecret(p),
  })

  // 對外連線可能整個不通（內網自架很常見），逾時要自己設 ——
  // 沒有的話這個請求會掛在那裡，使用者只看到一個轉不完的白畫面
  const res = await fetch(META[p].tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)

  if (!res) {
    throw badRequest(
      `連不上 ${PROVIDER_LABEL[p]}`,
      '這台伺服器要連得到外網才能完成登入，請檢查對外連線或防火牆。')
  }

  const data = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok || !data.id_token) {
    // 對方的錯誤碼原封不動帶出來 —— 自架的人要靠它才查得出是哪個設定填錯
    throw badRequest(
      `${PROVIDER_LABEL[p]} 沒有核發登入權杖`,
      data.error_description ?? data.error ?? `對方回應 HTTP ${res.status}`)
  }
  return data.id_token
}

// ── 驗 id_token ───────────────────────────────────────────

/**
 * 公鑰組。createRemoteJWKSet 自己處理抓取、快取與輪替（kid 對不上時才重抓），
 * 所以模組層建一次就好 —— 每次登入都重抓等於幫對方做壓力測試。
 */
const jwks: Record<ProviderId, ReturnType<typeof createRemoteJWKSet>> = {
  GOOGLE: createRemoteJWKSet(new URL(META.GOOGLE.jwksUrl)),
  APPLE: createRemoteJWKSet(new URL(META.APPLE.jwksUrl)),
}

export interface IdentityClaims {
  subject: string
  email: string | null
  /** 對方**明講**這個 email 已驗證才是 true。判斷不出來一律當成 false */
  emailVerified: boolean
  displayName: string | null
}

export async function verifyIdToken(
  p: ProviderId, idToken: string, expectedNonce: string
): Promise<IdentityClaims> {
  let payload
  try {
    // iss / aud / exp / 簽章一次驗完。少驗 aud 的話，別的網站發給它自己的
    // id_token 也能拿來登入這裡
    ;({ payload } = await jwtVerify(idToken, jwks[p], {
      issuer: META[p].issuer,
      audience: clientId(p),
    }))
  } catch {
    throw badRequest(
      `${PROVIDER_LABEL[p]} 回傳的登入憑證無法驗證`,
      '簽章、發行者或有效期不正確。請重新登入一次；持續失敗請確認站台時間是否正確。')
  }

  // nonce 對不上代表這張 token 不是這一次流程換來的（重放）
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw badRequest('登入流程對不起來，請重新登入一次')
  }

  // Apple 的 email_verified 有時是布林、有時是字串 "true"，兩種都收
  const raw = payload.email_verified
  const emailVerified = raw === true || raw === 'true'

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''

  return {
    subject: String(payload.sub),
    email: email || null,
    emailVerified,
    displayName: name || null,
  }
}

/**
 * Apple 在 form_post 的表單裡另外塞一個 `user` 欄位，裡面是名字。
 * **只有第一次授權會給**，之後同一個人再登入永遠是空的 —— 所以當下沒存就沒了。
 */
export function appleNameFromForm(userField: unknown): string | null {
  if (typeof userField !== 'string' || !userField.trim()) return null
  try {
    const parsed = JSON.parse(userField) as { name?: { firstName?: string; lastName?: string } }
    // 中文姓名是「姓在前」，英文相反 —— 這裡照 Apple 給的欄位順序接，
    // 反正使用者進來之後可以在帳號設定改成他想要的樣子
    const parts = [parsed.name?.lastName, parsed.name?.firstName]
      .map(s => (s ?? '').trim()).filter(Boolean)
    return parts.length ? parts.join(' ') : null
  } catch { return null }
}

/** 名字缺的時候的替代品：email 的前半段。空白的顯示名稱比什麼都難看 */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  return local.trim() || email
}

/** 只用在記錄失敗原因，不做任何信任判斷 —— 驗證一律走 verifyIdToken */
export const peekJwt = (token: string) => {
  try { return decodeJwt(token) } catch { return null }
}
