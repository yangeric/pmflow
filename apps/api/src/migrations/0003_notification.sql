-- 通知：系統第一次有「主動告訴某個人發生了什麼事」的能力
--
-- 起因是任務被別人指向時，負責人不會知道 —— 關聯是別人建立的，
-- 自己的任務卻因此多了一條依賴。原本畫面上唯一的提醒是「成員」頁籤的紅點，
-- 只涵蓋加入申請，而且要先進到那個專案才看得到。
--
-- 這裡刻意做成「已經發生的事件」而不是「現在待辦幾件」：
-- 待辦數（待審申請、逾期未回）是查詢時算出來的，處理完就歸零；
-- 通知是一則一則的紀錄，看過就算看過，不會因為對方後來又改回去就消失。
-- 兩者並存，各自回答不同的問題。
--
-- 沒有寄信，也沒有 WebSocket —— 前端靠輪詢。真的要即時推播是以後的事，
-- 但那時候讀的仍然是這張表，不必再改結構。

CREATE TABLE notification (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 收件人。一則通知只給一個人，要通知多人就寫多列 ——
  -- 已讀狀態是「每個人自己的」，共用一列的話就沒地方記。
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN (
                 'TASK_LINKED',     -- 有人建立了一條指向你負責的任務的關聯
                 'TASK_ASSIGNED',   -- 有人把任務指派給你
                 'JOIN_REQUESTED',  -- 有人申請加入你開的專案
                 'JOIN_APPROVED'    -- 你的加入申請被核准，或被建立者直接加入
               )),
  actor_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- 名字另外存一份：帳號被刪掉之後，通知還是要讀得出「是誰做的」。
  -- 這是刻意的去正規化，通知是歷史紀錄，不需要跟著改名。
  actor_name   text,
  project_id   uuid REFERENCES project(id) ON DELETE CASCADE,
  task_id      uuid REFERENCES task(id) ON DELETE CASCADE,
  -- 每種 kind 各自需要的細節（關聯種類、對方任務的代號…），
  -- 不為了四種事件開四組欄位
  body         jsonb NOT NULL DEFAULT '{}',
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 清單一律是「我的、最新的在上面」
CREATE INDEX ON notification (user_id, created_at DESC);
-- 未讀數量每 30 秒被問一次，用部分索引讓它只掃未讀的那幾列
CREATE INDEX ON notification (user_id) WHERE read_at IS NULL;
