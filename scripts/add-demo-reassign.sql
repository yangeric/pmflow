-- 補一筆示範用的「轉派」，讓成員頁的「曾經的任務」那一區有東西可看。
--
-- 為什麼需要：成員頁的「曾經的任務」＝這個人以前負責、後來轉派給別人的任務，
-- 資料來源是轉派的活動紀錄（`activity.body->>'reassign'`）。示範資料裡沒有
-- 任何一筆轉派，所以那一區永遠是空的，等於示範不到。
--
-- 這一筆寫出來的形狀跟 `POST /tasks/:id/reassign` 寫的**完全一樣**
-- （kind = FIELD_CHANGE，body 帶 reassign / assigneeId / assigneeName /
-- previousAssigneeId / previousAssigneeName / note）——
-- 形狀不一樣的話，查詢讀不到，等於補了個假資料騙自己。
--
-- 挑哪一張任務：MRG 專案裡**現在有負責人**、而且還沒有任何轉派紀錄的第一張。
-- 轉給誰：同工作區裡**不是現任負責人**的另一個人。兩邊都不寫死 id，
-- 所以在誰的資料庫上跑都成立。
--
-- 重跑安全：整段包在一個交易裡，而且 `NOT EXISTS` 擋掉「已經有轉派紀錄」的情況，
-- 跑第二次是 INSERT 0 0、UPDATE 0。
--
-- 需要工作區裡**至少兩個帳號**。只有一個帳號（全新安裝的示範資料就是）時
-- 什麼都不會做，並印出提示 —— 那不是錯誤，是資料不夠。

BEGIN;

CREATE TEMP TABLE pick ON COMMIT DROP AS
WITH candidate AS (
  SELECT t.id, t.workspace_id, t.assignee_id AS from_id
    FROM task t
    JOIN project p ON p.id = t.project_id
   WHERE p.key = 'MRG'
     AND t.deleted_at IS NULL
     AND t.assignee_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM activity a
        WHERE a.task_id = t.id AND (a.body->>'reassign') = 'true'
     )
   ORDER BY t.number
   LIMIT 1
)
SELECT c.id AS task_id, c.workspace_id, c.from_id,
       (SELECT wm.user_id
          FROM workspace_member wm
         WHERE wm.workspace_id = c.workspace_id
           AND wm.user_id <> c.from_id
         ORDER BY wm.user_id
         LIMIT 1) AS to_id
  FROM candidate c;

-- 沒有第二個人就整段不做
DELETE FROM pick WHERE to_id IS NULL;

INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body, created_at)
SELECT k.workspace_id, k.task_id, 'FIELD_CHANGE', k.from_id, uf.display_name,
       jsonb_build_object(
         'reassign', true,
         'assigneeId', k.to_id::text,
         'assigneeName', ut.display_name,
         'previousAssigneeId', k.from_id::text,
         'previousAssigneeName', uf.display_name,
         'note', '我這幾天請假，先把這張交給你；規格書在共用資料夾第三版。'
       ),
       now() - interval '3 days'
  FROM pick k
  JOIN app_user uf ON uf.id = k.from_id
  JOIN app_user ut ON ut.id = k.to_id;

-- 活動紀錄說換手了，任務身上的負責人就要真的跟著換 ——
-- 兩邊不一致的話，「曾經的任務」會同時出現在兩個人的「目前」裡
UPDATE task t
   SET assignee_id = k.to_id, updated_at = now()
  FROM pick k
 WHERE t.id = k.task_id;

COMMIT;

-- 跑完給人看的結果
SELECT p.key || '-' || t.number AS ref, t.title,
       a.body->>'previousAssigneeName' AS handed_from,
       a.body->>'assigneeName'         AS handed_to,
       to_char(a.created_at, 'YYYY-MM-DD') AS handed_on
  FROM activity a
  JOIN task t    ON t.id = a.task_id
  JOIN project p ON p.id = t.project_id
 WHERE (a.body->>'reassign') = 'true'
 ORDER BY a.created_at DESC;
