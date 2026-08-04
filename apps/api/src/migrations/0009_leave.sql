-- 請假紀錄
--
-- 為什麼要有這張表：排工作的時候，第一個要知道的不是「這件事誰做」，
-- 而是「這幾天誰在」。以前請假只存在群組訊息裡，排完才發現當事人不在，
-- 於是整條後續任務跟著位移。把「人不在」畫進同一張行事曆，
-- 排程的人在按下去之前就看得到。
--
-- 為什麼掛在工作區而不是專案：一個人請假是整個人不在，不是只有某個專案不在。
-- 掛在專案的話，同一段假期得在每個專案各填一次，而且一定會有人漏填一個，
-- 於是那個專案的人以為他還在。
--
-- 為什麼是日曆日而不是工作天：填的人講的是「我 8/1 到 8/5 不在」，
-- 那是他請假單上的日期。要換算成工作天是看的人的事（畫面上照日曆畫），
-- 存進來就先換算的話，遇到補班日、國定假日調整就再也還原不回原始的假單。
-- 起訖日都含當天 —— 單日假就是起迄同一天，不需要另一個「全天」旗標。
--
-- 為什麼不做簽核流程：這裡記的是「已經確定的請假」，不是申請單。
-- 誰能填由權限擋（本人或工作區管理者，見 routes/leaves.ts），
-- 狀態欄一旦出現就得配一整套審核、退件、撤回，而使用者要的只是排工作看得到人。

CREATE TABLE leave_record (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 請假的那個人。跟「誰填的」分開兩欄 —— 管理者可以代填，
  -- 合在一起的話就分不出「他自己請的」跟「主管幫他登的」。
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- 假別存英文 key，畫面上一律顯示中文（web/src/strings/calendar.ts）。
  -- 存中文的話改用詞就得改資料，而且排序、統計會跟著語言走。
  leave_type   text NOT NULL CHECK (leave_type IN (
                 'PERSONAL','SICK','ANNUAL','OFFICIAL','MARRIAGE','BEREAVEMENT','OTHER')),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  -- 備註只有本人與工作區管理者讀得到（在路由層濾掉）。
  -- 「誰請假、哪幾天」是排工作要用的資訊，但「為什麼請」不是。
  note         text CHECK (note IS NULL OR btrim(note) <> ''),
  created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- 起日不能晚於迄日。前端擋、路由也擋，這裡是最後一道 ——
  -- 反過來的區間會讓行事曆畫出負寬度的長條，整列排版跟著爆掉。
  CONSTRAINT leave_record_dates CHECK (start_date <= end_date),

  -- 只能替「這個工作區裡的人」登記請假。用複合外鍵而不是在程式裡查，
  -- 是因為這個條件同時保證了另一件事：人被移出工作區時，他的請假紀錄
  -- 一起消失，不會留在別人的行事曆上變成永遠的幽靈。
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_member (workspace_id, user_id) ON DELETE CASCADE
);

-- 行事曆固定是「這個工作區、這段期間有誰請假」
CREATE INDEX ON leave_record (workspace_id, start_date, end_date);
-- 複合外鍵的級聯刪除要走這條，不然移除成員時得整表掃一次
CREATE INDEX ON leave_record (workspace_id, user_id);
