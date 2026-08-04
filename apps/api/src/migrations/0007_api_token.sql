-- 給機器用的長期憑證
--
-- 起因是「別的系統要能自己建任務」。原本站上唯一的憑證是登入換來的
-- access token，15 分鐘就過期，而換新的那條路要 refresh cookie ——
-- 那是為瀏覽器設計的，腳本、排程、第三方系統都走不了。
--
-- 刻意不做「機器帳號」：權杖直接掛在人身上，拿權杖呼叫就等於那個人在呼叫，
-- 專案角色、成員資格全部沿用既有的 require* 檢查。多一套權限模型就多一個
-- 會跟主線走鐘的地方，而且離職時要收回權限的人會漏掉那些看不見的帳號。
--
-- 只存雜湊不存明文，用 sha256 而不是 scrypt：權杖是 256 位元的亂數，
-- 不是使用者想得出來的密碼，字典攻擊不成立，慢雜湊防的東西這裡不存在；
-- 反過來每一次 API 呼叫都要驗一次，scrypt 的 100ms 會讓它根本不能用。
-- 這跟 refresh_token 是同一套理由。

CREATE TABLE api_token (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- 使用者自己取的名字，用來回答「這把是給誰用的、還能不能撤掉」
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  -- 明文的前 14 碼。清單上要讓人認得出手上那把是哪一把，
  -- 但又不能存完整明文 —— 前綴洩漏的位元數對 256 位元的亂數不痛不癢。
  prefix       text NOT NULL,
  -- 不設到期日是允許的：自架站台常常就是要一把長期不換的整合金鑰，
  -- 強迫到期只會讓人在到期那天手忙腳亂，或乾脆把日期設到 2099。
  expires_at   timestamptz,
  -- 撤銷用軟刪除。留著才回答得了「那把外洩的權杖是什麼時候被停掉的」，
  -- 也讓同一個雜湊不會被之後的新權杖佔回去。
  revoked_at   timestamptz,
  -- 「這把還有人在用嗎」是清權杖時唯一有用的資訊。
  -- 只記到分鐘等級（見 lib/auth.ts 的節流），不是每次呼叫都寫。
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 清單一律是「我的、最新的在上面」
CREATE INDEX ON api_token (user_id, created_at DESC);
