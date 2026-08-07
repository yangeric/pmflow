-- 請假的代理人
--
-- 為什麼掛在「這一筆請假」而不是掛在人身上：同一個人不同次請假可以找不同的人代，
-- 而且請假結束代理權就該自動消失。掛在人身上的話就得再做一組「開始代理／結束代理」
-- 的開關，而那種開關一定會有人忘記關 —— 於是某個人就永遠握著別人的權限。
-- 請假的起訖日本來就是「這幾天他不在」，直接拿它當代理期間，不必再維護第二份日期。
--
-- 可以是空的：不是每次請假都要找人代（請一天特休通常不必）。
--
-- 為什麼只用單欄外鍵、不像 user_id 那樣做 (workspace_id, ...) 的複合外鍵：
-- user_id 那條複合外鍵是為了讓「人被移出工作區時，他的請假一起消失」。
-- 代理人不一樣 —— 代理人離開工作區時，**請假本身還是成立的**，
-- 不該把當事人的假一起刪掉（CASCADE），也沒辦法把 workspace_id 一起設成 NULL
-- （它是 NOT NULL）。所以這裡只保證「指到一個存在的帳號」，
-- 「代理人必須是同工作區的人」在路由層擋（routes/leaves.ts）。
-- 權限判斷那一端也不會因此出事：代理人要先過專案成員那一關才走得到代理判斷
-- （見 lib/auth.ts 的 requireProjectRole），人都不在了就什麼也代不到。
ALTER TABLE leave_record
  ADD COLUMN deputy_id uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- 代理人不可以是請假的人自己。前端不畫、路由擋，這裡是最後一道 ——
-- 自己代自己在權限上等於沒有效果，但會讓畫面顯示「代理：他自己」，
-- 看的人會以為那個人其實有在上班。
ALTER TABLE leave_record
  ADD CONSTRAINT leave_record_deputy_not_self
  CHECK (deputy_id IS NULL OR deputy_id <> user_id);

-- 權限判斷問的固定是「今天我正在代理誰」（deputy_id ＋ 落在起訖日內）。
-- 只索引有指定代理人的那些列 —— 絕大多數請假沒有代理人，不必進索引。
CREATE INDEX ON leave_record (deputy_id, start_date, end_date) WHERE deputy_id IS NOT NULL;
