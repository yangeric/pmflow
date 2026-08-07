-- 用 Google／Apple 的帳號登入
--
-- 這是**綁定**不是取代：email + 密碼那條路一個字都沒有動，app_user 也沒有改。
-- 一個人可以同時綁 Google 與 Apple、也可以一個都不綁，密碼永遠是回得來的那條路。
--
-- 為什麼另外開一張表而不是在 app_user 上加 google_sub / apple_sub 兩欄：
--   1. 一個帳號要能綁多個提供者，加欄位等於每多支援一家就改一次 app_user；
--   2. 綁定是有生命週期的東西（什麼時候綁的、最後一次用它登入是什麼時候），
--      那些欄位掛在 app_user 上會變成一堆前綴一樣的欄位。
--
-- (provider, subject) 是唯一鍵：subject 是對方給的使用者 id（id_token 的 sub），
-- **不是 email**。email 會被使用者改、Apple 還會給轉寄用的假地址（private relay），
-- 只有 sub 是那家永遠不會回收、也不會變的識別碼。有了這個唯一鍵，
-- 同一個 Google 帳號就不可能同時綁在兩個 PMFlow 帳號上。
--
-- email 與 display_name 存的是**授權當下對方給的值**，只當參考：
-- Apple 的名字只有第一次授權會給，當下沒存就再也拿不到了。
-- 真正顯示用的仍然是 app_user 上的那兩欄。

CREATE TABLE oauth_identity (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('GOOGLE','APPLE')),
  -- id_token 的 sub。長度沒有上限保證，所以用 text 不用 varchar(n)
  subject       text NOT NULL,
  -- 授權當下對方給的 email。可能是 Apple 的轉寄地址，也可能整個沒有
  email         citext,
  -- Apple 只有第一次授權會給名字，之後再也拿不到 —— 所以當下就存起來
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- 同一個提供者的同一個人，只能綁在一個 PMFlow 帳號上
  UNIQUE (provider, subject)
);

-- 帳號設定頁要列出「我綁了哪幾種」，一律照這個方向查
CREATE INDEX ON oauth_identity (user_id);
