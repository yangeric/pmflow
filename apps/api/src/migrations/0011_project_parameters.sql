-- 每個專案自己的系統參數：優先度與任務類型
--
-- 狀態欄本來就是每個專案一份（task_status），但優先度與任務類型從第一天就
-- 寫死在 task 的 CHECK 裡：type IN ('TASK','MILESTONE','BUG','EPIC')、
-- priority IN ('LOW','NORMAL','HIGH','URGENT')。
--
-- 為什麼要改：這兩份清單本來就不該全站共用。蓋房子的專案要「圖說審查」這種
-- 類型，辦活動的專案要「等廠商報價」，硬要共用一套只會逼所有人遷就別人的流程；
-- 而寫在 CHECK 裡的清單，連加一個值都得發一次版。
--
-- 形狀刻意比照 task_status（per project + key/name/color/rank），
-- 三種參數在 API 與畫面上才能用同一套程式處理，不必為了兩張表再寫兩份 CRUD。
--
--   key    程式用的鍵，task.priority / task.type 指的就是它。**建立後不可修改** ——
--          任務是靠它指回來的，改了等於把既有任務指向不存在的值。
--   name   畫面上顯示的字，隨時可以改。
--   color  徽章顏色，使用者自己挑的。
--   rank   顯示順序，跟卡片排序同一套 fractional ranking（lib/rank.ts）。
--
-- 刻意不做的事：
--  * 不加 task.priority / task.type → 新表的外鍵。任務可能因為
--    別的專案的資料搬移、或參數被刪除而暫時指到不存在的 key，外鍵會讓那些
--    情況直接寫不進去；「還有人在用就不准刪」這條規則在應用層擋得更清楚
--    （而且能一併把那些任務改到別的值上）。task_status 也是同樣的做法。
--  * 不做 category：那是狀態專屬的（決定算不算「還沒做完」），
--    優先度與類型沒有這個概念，硬加一欄只會有人去填它然後期待它有作用。

CREATE TABLE task_priority (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#94a3b8',
  rank       numeric NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE task_type (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#94a3b8',
  rank       numeric NOT NULL,
  UNIQUE (project_id, key)
);

-- ── 回填：既有的每一個專案都補上原本那四個優先度與四個類型 ──
--
-- key 沿用原本 CHECK 裡的大寫值，既有任務的 priority / type 一個字都不用改，
-- 直接就指得回來。名稱沿用畫面上一直在用的中文（web/src/strings/task.ts）。
-- 用 NOT EXISTS 而不是 ON CONFLICT：萬一重跑或已經有同 key 的資料，
-- 那是使用者的東西，不要覆蓋。
--
-- 新開的專案走程式裡的預設清單（routes/projects.ts 的
-- DEFAULT_PRIORITIES / DEFAULT_TYPES），跟 DEFAULT_STATUSES 放在一起。

INSERT INTO task_priority (project_id, key, name, color, rank)
SELECT p.id, v.key, v.name, v.color, v.rank
FROM project p
CROSS JOIN (VALUES
  ('LOW',    '低',   '#94a3b8', 1000),
  ('NORMAL', '普通', '#3178c6', 2000),
  ('HIGH',   '高',   '#e07b39', 3000),
  ('URGENT', '緊急', '#dc2626', 4000)
) AS v(key, name, color, rank)
WHERE NOT EXISTS (
  SELECT 1 FROM task_priority x WHERE x.project_id = p.id AND x.key = v.key
);

INSERT INTO task_type (project_id, key, name, color, rank)
SELECT p.id, v.key, v.name, v.color, v.rank
FROM project p
CROSS JOIN (VALUES
  ('TASK',      '任務',   '#3178c6', 1000),
  ('MILESTONE', '里程碑', '#8b5cf6', 2000),
  ('BUG',       '缺陷',   '#dc2626', 3000),
  ('EPIC',      '大項目', '#d97706', 4000)
) AS v(key, name, color, rank)
WHERE NOT EXISTS (
  SELECT 1 FROM task_type x WHERE x.project_id = p.id AND x.key = v.key
);

-- ── 拿掉 task 上那兩個寫死清單的 CHECK ──
--
-- 值現在由每個專案自己定義，資料表不可能知道合法清單長什麼樣（它跟著
-- project_id 走）。**拿掉 CHECK 不等於不驗** —— 驗證改在應用層做：
-- 寫入前先確認「這個 key 在這個專案的清單裡存不存在」
-- （routes/parameters.ts 的 assertParamKey）。這跟 status_key 從第一天起
-- 就是同一種做法：它也沒有 CHECK，因為合法值同樣是 per project 的。
--
-- 不寫死 constraint 名稱去 DROP：那兩個是欄位上的匿名 CHECK，名字是
-- PostgreSQL 自己取的（task_type_check / task_priority_check），
-- 但從很舊的版本升上來的資料庫不保證叫這個。改成照「定義內容」去找，
-- 只會命中提到那些列舉值的 CHECK，不會誤傷 progress、日期那幾條。

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'task'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%MILESTONE%'
        OR pg_get_constraintdef(oid) LIKE '%URGENT%')
  LOOP
    EXECUTE format('ALTER TABLE task DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- 「這個值還有幾張任務在用」是刪除參數前必問的一句話，
-- 每次都全表掃描不合理（清單頁一次要問三種參數的每一列）。
CREATE INDEX task_project_priority_idx ON task (project_id, priority) WHERE deleted_at IS NULL;
CREATE INDEX task_project_type_idx     ON task (project_id, type)     WHERE deleted_at IS NULL;
