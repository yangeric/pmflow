import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { sql } from '../lib/db.js'
import { env } from '../lib/env.js'
import { authenticate, newRefreshToken } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound, HttpProblem } from '../lib/errors.js'
import {
  PROVIDER_LABEL, type ProviderId, type OauthMode,
  toProviderId, configuredProviders, assertConfigured,
  newStateSecret, hashStateSecret, signState, verifyState, newNonce,
  signLinkTicket, verifyLinkTicket,
  authorizeUrl, usesFormPost, exchangeCode, verifyIdToken,
  appleNameFromForm, nameFromEmail, type IdentityClaims,
} from '../lib/oauth.js'

/**
 * 用 Google／Apple 的帳號登入。
 *
 * **這是綁定，不是取代。** email + 密碼那條路一個字都沒改，
 * 一個帳號可以同時綁兩家、也可以一個都不綁。規則寫在 AGENTS.md，摘要：
 *
 *  - 第一次用 Google／Apple 登入、而那個 email 還沒有帳號 → **直接開一個**。
 *    登入頁本來就開放註冊，這條路不該比它更嚴。
 *  - email 已經有帳號 → **只有對方明講「這個 email 已驗證」才自動綁上去**。
 *    沒驗證就請他先用密碼登入，再到帳號設定綁 —— 不然任何人只要在別的地方
 *    註冊一個同名 email 就能接管別人的帳號。
 *  - **不可以解除最後一個登入方式**：沒有密碼又解掉唯一的綁定，那個人就再也進不來了。
 *
 * 兩種進場方式，差別只在回來之後怎麼收尾：
 *  - **登入**：整頁導出去，回來時發 refresh cookie 再導回站台首頁。
 *    前端一開頁本來就會拿那張 cookie 去 /auth/refresh 換 access token
 *    （見 web/src/lib/auth.tsx），所以權杖完全走既有那一套，這裡沒有另發一種。
 *  - **綁定**：開小視窗跑，回來時只寫 oauth_identity，然後用 postMessage 通知
 *    原本那一頁並關掉自己 —— 帳號設定頁不會被整頁換掉，使用者停在原處。
 */

/** state 的另一半（亂數本體）放這個 cookie，跟 state 裡的雜湊配對才算數 */
const STATE_COOKIE = 'pmflow_oauth'
/** 只有 /auth/oauth 底下需要這個 cookie，路徑收窄一點，其他請求就不會帶著它跑 */
const STATE_COOKIE_PATH = '/api/v1/auth/oauth'
const STATE_MAX_AGE = 600

/** 小視窗回報給開它的那一頁的訊息型別。前端 AccountPanel 對著這個字串收 */
const LINK_MESSAGE = 'pmflow:oauth-link'

export default async function oauthRoutes(app: FastifyInstance) {

  /**
   * Apple 的 form_post 送回來的是 `application/x-www-form-urlencoded`，
   * 而 Fastify 內建只認得 JSON 與純文字 —— 沒有這一段，Apple 的 callback
   * 會一律 415。
   *
   * 刻意不裝 @fastify/formbody：整個站只有這一支端點收表單，
   * 為它多一個相依（也多一份要過授權白名單的東西）不划算。
   * 這裡加的解析器只在這個 plugin 的範圍內生效，其他路由完全不受影響。
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded', { parseAs: 'string' },
    (_req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(body as string))) }
      catch (err) { done(err as Error, undefined) }
    })

  /**
   * 登入頁要畫哪幾顆按鈕。
   *
   * **沒設定的那一家不會出現在這份清單裡** —— 畫一顆按下去一定壞的按鈕，
   * 比沒有那個功能還糟。這支不需要登入（登入頁本來就還沒有人），
   * 而且只回「哪幾家可以用」，沒有任何設定值。
   */
  app.get('/auth/oauth/providers', async () => ({
    providers: configuredProviders().map(id => ({ id, label: PROVIDER_LABEL[id] })),
  }))

  /**
   * 綁定用的一次性入場券。
   *
   * 為什麼要這一步：導向對方的授權頁是**整頁跳轉**，瀏覽器不會帶
   * Authorization 標頭，所以後端在 callback 回來時無從得知「這是誰要綁」。
   * 把 access token 塞進網址是最省事的做法，但那張權杖活 15 分鐘、
   * 而且會留在瀏覽紀錄與代理伺服器的日誌裡。這張票只活 60 秒、
   * 只能拿來做綁定這一件事。
   */
  app.post('/me/oauth/link-ticket', async req => {
    const auth = await authenticate(req)
    return { ticket: await signLinkTicket(auth.id) }
  })

  /** 我綁了哪幾種登入方式，還有「現在能不能解除」 */
  app.get('/me/oauth/identities', async req => {
    const auth = await authenticate(req)
    return loadIdentities(auth.id)
  })

  /**
   * 解除綁定。
   *
   * **擋在後端**：沒有密碼、又只剩這一個綁定時不准解 —— 解完就再也登不進來，
   * 而這個站沒有寄信的能力，沒有「忘記密碼」那條路可以救。
   * 前端會把按鈕收起來並說明原因，但規則本身一定要在這裡。
   */
  app.delete<{ Params: { id: string } }>('/me/oauth/identities/:id', async (req, reply) => {
    const auth = await authenticate(req)
    const state = await loadIdentities(auth.id)

    const target = state.identities.find(i => i.id === req.params.id)
    if (!target) throw notFound('找不到這個綁定，或它已經解除了')

    if (!state.canUnlink) {
      throw badRequest(
        '這是你唯一的登入方式，解除之後就進不來了',
        '請先到上面的「變更密碼」設一組密碼，或先綁定另一種登入方式，再回來解除這一個。')
    }

    await sql`DELETE FROM oauth_identity WHERE id = ${target.id} AND user_id = ${auth.id}`
    return reply.code(204).send()
  })

  /**
   * 導向 Google／Apple 的授權頁。
   *
   * 這支是**瀏覽器直接開的網址**（整頁跳轉或小視窗），不是 fetch ——
   * 所以錯誤不能只回 JSON，會變成使用者看到一頁原始的 JSON。
   * 設定不齊時導回登入頁並把原因帶上（login 模式），或在小視窗裡講清楚（link 模式）。
   */
  app.get<{ Params: { provider: string }; Querystring: { ticket?: string } }>(
    '/auth/oauth/:provider/start', async (req, reply) => {
      const provider = toProviderId(req.params.provider)
      if (!provider) throw notFound('沒有這種登入方式')

      const mode: OauthMode = req.query.ticket ? 'link' : 'login'

      try {
        assertConfigured(provider)

        let userId: string | undefined
        if (mode === 'link') userId = await verifyLinkTicket(req.query.ticket!)

        const secret = newStateSecret()
        const nonce = newNonce()
        const state = await signState({
          provider, mode, userId, nonce, cookieHash: secret.hash,
        })

        setStateCookie(reply, provider, secret.raw)
        return reply.redirect(authorizeUrl(provider, state, nonce))
      } catch (err) {
        return finish(reply, mode, provider, err)
      }
    })

  /**
   * 對方把人送回來的地方。
   *
   * Google 走 GET（授權碼在 query），Apple 走 POST（form_post，因為我們要名字）——
   * 兩支共用同一段處理，差別只有參數從哪裡讀。
   */
  const callbackSchema = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    /** Apple 專屬：第一次授權才會有，裡面是名字 */
    user: z.string().optional(),
  })

  async function callback(
    req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply
  ) {
    const provider = toProviderId(req.params.provider)
    if (!provider) throw notFound('沒有這種登入方式')

    // Apple 用 form_post，值在 body；Google 在 query。兩邊都讀，誰有值算誰
    const q = callbackSchema.safeParse(req.query ?? {})
    const b = callbackSchema.safeParse(req.body ?? {})
    const p = { ...(q.success ? q.data : {}), ...(b.success ? b.data : {}) }

    // state 先解出來才知道這是登入還是綁定 —— 失敗時要導去不同的地方
    let mode: OauthMode = 'login'
    try {
      if (!p.state) throw badRequest('登入流程缺少識別碼，請重新登入一次')
      const state = await verifyState(p.state)
      mode = state.mode

      if (state.provider !== provider) {
        throw badRequest('登入流程對不起來，請重新登入一次')
      }

      // ── CSRF：state 裡的雜湊要對得上這台瀏覽器手上的 cookie ──
      const cookie = (req.cookies as Record<string, string | undefined>)?.[STATE_COOKIE]
      if (!cookie || hashStateSecret(cookie) !== state.cookieHash) {
        throw badRequest(
          '登入流程無法驗證，請重新登入一次',
          '瀏覽器沒有帶回這次登入的識別資料。若使用無痕視窗或封鎖了 Cookie，請改用一般視窗再試。')
      }
      clearStateCookie(reply, provider)

      // 使用者在對方的畫面上按了取消，或對方拒絕這次授權
      if (p.error) {
        throw badRequest(
          `${PROVIDER_LABEL[provider]} 沒有完成這次授權`,
          p.error_description ?? p.error)
      }
      if (!p.code) throw badRequest('沒有拿到授權碼，請重新登入一次')

      const idToken = await exchangeCode(provider, p.code)
      const claims = await verifyIdToken(provider, idToken, state.nonce)

      // Apple 的名字只有第一次授權會出現在表單裡，當下沒收就永遠拿不到
      const claimsWithName: IdentityClaims = {
        ...claims,
        displayName: claims.displayName ?? appleNameFromForm(p.user),
      }

      if (mode === 'link') {
        await linkIdentity(provider, state.userId!, claimsWithName)
        return finish(reply, 'link', provider, null)
      }

      const userId = await resolveLogin(provider, claimsWithName)
      await issueRefreshCookie(reply, userId)
      return finish(reply, 'login', provider, null)
    } catch (err) {
      return finish(reply, mode, provider, err)
    }
  }

  app.get<{ Params: { provider: string } }>('/auth/oauth/:provider/callback', callback)
  app.post<{ Params: { provider: string } }>('/auth/oauth/:provider/callback', callback)
}

// ── 綁定與登入的規則 ────────────────────────────────────────

/**
 * 這個人有哪些登入方式，還剩幾個。
 *
 * `canUnlink` 是整段規則的重點：**最後一個登入方式不能解除**。
 * 有密碼的話綁定隨便解都沒關係（密碼永遠回得來）；沒有密碼的人
 * 手上至少要留兩個綁定，才解得掉其中一個。
 */
async function loadIdentities(userId: string) {
  const [account] = await sql<{ hasPassword: boolean }[]>`
    SELECT (password_hash IS NOT NULL) AS "hasPassword"
    FROM app_user WHERE id = ${userId}`
  if (!account) throw notFound('找不到帳號')

  const identities = await sql<{
    id: string; provider: ProviderId; email: string | null
    displayName: string | null; createdAt: string; lastLoginAt: string | null
  }[]>`
    SELECT id, provider, email, display_name AS "displayName",
           created_at AS "createdAt", last_login_at AS "lastLoginAt"
    FROM oauth_identity WHERE user_id = ${userId}
    ORDER BY created_at`

  return {
    hasPassword: account.hasPassword,
    identities,
    /** 現在還可以綁哪幾家（已經綁過的與沒設定的都不列） */
    available: configuredProviders().filter(p => !identities.some(i => i.provider === p)),
    canUnlink: account.hasPassword || identities.length > 1,
  }
}

/** 綁定：把這個 Google／Apple 身分掛到「已經登入的這個人」身上 */
async function linkIdentity(
  provider: ProviderId, userId: string, claims: IdentityClaims
): Promise<void> {
  const [existing] = await sql<{ user_id: string }[]>`
    SELECT user_id FROM oauth_identity
    WHERE provider = ${provider} AND subject = ${claims.subject}`

  if (existing) {
    if (existing.user_id === userId) return    // 已經綁好了，重按一次不算錯
    throw conflict(
      `這個 ${PROVIDER_LABEL[provider]} 帳號已經綁在另一個帳號上`,
      '一個外部帳號只能綁一個 PMFlow 帳號。請先用原本那個帳號登入並解除綁定。')
  }

  await sql`
    INSERT INTO oauth_identity (user_id, provider, subject, email, display_name, last_login_at)
    VALUES (${userId}, ${provider}, ${claims.subject},
            ${claims.email}, ${claims.displayName}, NULL)`
}

/**
 * 登入：把對方給的身分換成「這個站的哪一個帳號」。
 *
 * 三條路，順序不能換：
 *  1. 這個外部身分綁過了 → 就是那個人（**只認 subject，不認 email**，
 *     email 會被改、Apple 還會給轉寄地址，subject 才是不會變的識別碼）。
 *  2. email 已經有帳號 → **對方明講已驗證才自動綁上去**，否則要求先用密碼登入。
 *  3. 都沒有 → 開一個新帳號（登入頁本來就開放註冊，這條路不該更嚴）。
 */
async function resolveLogin(provider: ProviderId, claims: IdentityClaims): Promise<string> {
  const label = PROVIDER_LABEL[provider]

  // ── 1. 綁過了 ──
  const [known] = await sql<{ id: string; user_id: string; status: string }[]>`
    SELECT oi.id, oi.user_id, u.status
    FROM oauth_identity oi JOIN app_user u ON u.id = oi.user_id
    WHERE oi.provider = ${provider} AND oi.subject = ${claims.subject}`

  if (known) {
    if (known.status !== 'ACTIVE') throw forbidden('帳號尚未啟用或已被停用')
    // 對方那邊改了 email 或名字時跟著更新，但只更新這張綁定的紀錄 ——
    // app_user 上的 email 是登入帳號，不該被外部系統默默改掉
    await sql`
      UPDATE oauth_identity
      SET last_login_at = now(),
          email        = COALESCE(${claims.email}, email),
          display_name = COALESCE(${claims.displayName}, display_name)
      WHERE id = ${known.id}`
    return known.user_id
  }

  // ── 2 與 3 都要 email：沒有 email 就沒辦法開帳號，也沒辦法判斷是不是同一個人 ──
  if (!claims.email) {
    throw badRequest(
      `${label} 沒有提供電子郵件，無法用它建立帳號`,
      `請先用 email 與密碼登入，再到「帳號設定」綁定 ${label}。`)
  }

  const [existing] = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM app_user WHERE email = ${claims.email}`

  // ── 2. email 已經有帳號 ──
  if (existing) {
    if (!claims.emailVerified) {
      throw badRequest(
        `這個電子郵件已經有帳號了，但 ${label} 沒有確認它屬於你`,
        `請先用 email 與密碼登入，再到「帳號設定」綁定 ${label}。` +
        '（沒有這道關卡的話，任何人只要在別處註冊一個同名的信箱就能接管這個帳號。）')
    }
    if (existing.status !== 'ACTIVE') throw forbidden('帳號尚未啟用或已被停用')

    await sql`
      INSERT INTO oauth_identity (user_id, provider, subject, email, display_name, last_login_at)
      VALUES (${existing.id}, ${provider}, ${claims.subject},
              ${claims.email}, ${claims.displayName}, now())`
    return existing.id
  }

  // ── 3. 開一個新帳號 ──
  if (!env.allowSelfRegistration) {
    throw forbidden('本站已關閉自行註冊，請聯絡管理員邀請')
  }
  if (env.allowedEmailDomains.length) {
    const domain = claims.email.split('@')[1]?.toLowerCase() ?? ''
    if (!env.allowedEmailDomains.includes(domain)) {
      throw forbidden(`只開放這些網域註冊：${env.allowedEmailDomains.join(', ')}`)
    }
  }

  const email = claims.email
  const displayName = claims.displayName ?? nameFromEmail(email)

  return sql.begin(async tx => {
    // password_hash 留空 —— 這個帳號目前只有這一種登入方式，
    // 他之後可以在帳號設定自己設一組密碼
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app_user (email, password_hash, display_name, status, email_verified_at)
      VALUES (${email}, NULL, ${displayName}, 'ACTIVE',
              ${claims.emailVerified ? new Date() : null})
      RETURNING id`

    // 工作區的歸屬跟 /auth/register 是同一套：沒有任何工作區時第一個人是 OWNER，
    // 否則自動加入最早那個工作區當 MEMBER。兩條路長得不一樣的話，
    // 用哪種方式註冊會決定你進不進得了同事的工作區，那太難解釋了。
    const [{ count }] = await tx<{ count: string }[]>`SELECT count(*) FROM workspace`
    if (Number(count) === 0) {
      const slug = `ws-${Math.random().toString(36).slice(2, 8)}`
      const [ws] = await tx<{ id: string }[]>`
        INSERT INTO workspace (slug, name) VALUES (${slug}, ${`${displayName} 的工作區`})
        RETURNING id`
      await tx`INSERT INTO workspace_member (workspace_id, user_id, role)
               VALUES (${ws.id}, ${user.id}, 'OWNER')`
    } else {
      const [ws] = await tx<{ id: string }[]>`
        SELECT id FROM workspace ORDER BY created_at LIMIT 1`
      if (ws) {
        await tx`INSERT INTO workspace_member (workspace_id, user_id, role)
                 VALUES (${ws.id}, ${user.id}, 'MEMBER')`
      }
    }

    await tx`
      INSERT INTO oauth_identity (user_id, provider, subject, email, display_name, last_login_at)
      VALUES (${user.id}, ${provider}, ${claims.subject},
              ${email}, ${claims.displayName}, now())`

    return user.id
  })
}

// ── 發權杖與 cookie ─────────────────────────────────────────

/**
 * 登入成功之後只做一件事：發 refresh cookie。
 *
 * **刻意不在這裡回 access token。** 前端一開頁本來就會拿這張 cookie 去
 * /auth/refresh 換一張（見 web/src/lib/auth.tsx 的 useEffect），
 * 走的是跟密碼登入完全相同的那段程式。在網址上多帶一張 access token 出去，
 * 等於讓它留在瀏覽紀錄與代理伺服器的日誌裡，換不到任何好處。
 *
 * cookie 的設定跟 routes/auth.ts 的 setRefreshCookie 一字不差 ——
 * 兩邊發的是同一種東西，任何一邊改了另一邊也要改。
 */
async function issueRefreshCookie(reply: FastifyReply, userId: string): Promise<void> {
  const { raw, hash } = newRefreshToken()
  await sql`
    INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at)
    VALUES (${userId}, uuidv7(), ${hash}, now() + ${env.refreshTtlSec + ' seconds'}::interval)`

  reply.setCookie('pmflow_rt', raw, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.isProd,
    path: '/',
    maxAge: env.refreshTtlSec,
  })
}

/**
 * state 的另一半。
 *
 * `sameSite` 要看對方怎麼把人送回來：
 *  - Google 走 GET 跳轉 → `lax` 就送得出去。
 *  - Apple 走 **跨站 POST**（form_post）→ `lax` 的 cookie 在那個請求上不會被帶回來，
 *    只能用 `none`，而 `none` 一定要配 `secure`。這不是問題 ——
 *    Apple 本來就只收 https 的 callback，所以走到這條路的站台一定是 https。
 */
function setStateCookie(reply: FastifyReply, provider: ProviderId, raw: string): void {
  const crossSitePost = usesFormPost(provider)
  reply.setCookie(STATE_COOKIE, raw, {
    httpOnly: true,
    sameSite: crossSitePost ? 'none' : 'lax',
    secure: crossSitePost || env.publicUrl.startsWith('https://'),
    path: STATE_COOKIE_PATH,
    maxAge: STATE_MAX_AGE,
  })
}

function clearStateCookie(reply: FastifyReply, provider: ProviderId): void {
  reply.clearCookie(STATE_COOKIE, {
    path: STATE_COOKIE_PATH,
    sameSite: usesFormPost(provider) ? 'none' : 'lax',
    secure: usesFormPost(provider) || env.publicUrl.startsWith('https://'),
  })
}

// ── 收尾：把結果交還給瀏覽器 ─────────────────────────────────

/** 錯誤訊息攤平成一句話。這是要顯示給使用者看的，不是給程式判斷的 */
function messageOf(err: unknown): string {
  if (err instanceof HttpProblem) {
    return [err.title, err.detail].filter(Boolean).join('：')
  }
  return '登入沒有完成，請再試一次'
}

/**
 * 這一趟的結局。
 *
 * 登入模式是整頁跳轉，所以導回站台首頁；失敗時把原因放在網址上，
 * 登入頁讀到就顯示（見 web/src/pages/Login.tsx）。
 * 綁定模式跑在小視窗裡，回一頁極小的 HTML：通知開它的那一頁、然後關掉自己。
 */
function finish(
  reply: FastifyReply, mode: OauthMode, provider: ProviderId, err: unknown
): FastifyReply {
  const ok = err === null || err === undefined
  if (!ok) reply.log.warn({ err, provider, mode }, '外部帳號登入失敗')

  const base = env.publicUrl || ''

  if (mode === 'login') {
    const url = ok
      ? `${base}/`
      : `${base}/?loginError=${encodeURIComponent(messageOf(err))}`
    return reply.redirect(url)
  }

  return reply
    .type('text/html; charset=utf-8')
    .send(popupHtml(provider, ok, ok ? '' : messageOf(err)))
}

/**
 * 綁定用小視窗的收尾頁。
 *
 * 只做兩件事：用 postMessage 告訴開它的那一頁結果，然後關掉自己。
 * 收不到 window.opener（使用者把小視窗另存成分頁之類）時退回顯示一句話，
 * 不要留一片空白讓人以為當掉了。
 *
 * postMessage 的目標網域寫死成站台自己的網址，不用 `*` ——
 * 用 `*` 的話這頁的內容任何一個把它嵌起來的網站都讀得到。
 */
function popupHtml(provider: ProviderId, ok: boolean, message: string): string {
  const payload = JSON.stringify({
    type: LINK_MESSAGE, provider, ok, message,
    // `</script>` 出現在字串裡會提早關掉這個標籤，一律轉義
  }).replace(/</g, '\\u003c')
  const origin = JSON.stringify(env.publicUrl || '/').replace(/</g, '\\u003c')
  const text = ok
    ? `已完成與 ${PROVIDER_LABEL[provider]} 的綁定，可以關掉這個視窗了。`
    : message

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<title>${ok ? '綁定完成' : '綁定沒有完成'}</title>
<style>body{font:15px/1.7 system-ui,"Noto Sans TC",sans-serif;margin:3rem auto;max-width:32rem;
padding:0 1.5rem;color:#1e293b}@media(prefers-color-scheme:dark){body{background:#020617;color:#e2e8f0}}</style>
</head><body><p>${escapeHtml(text)}</p>
<script>
(function(){
  try { if (window.opener) window.opener.postMessage(${payload}, ${origin}); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 300);
})();
</script>
</body></html>`
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
