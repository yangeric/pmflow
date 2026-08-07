-- 給「同時完成」那一組補一張下游任務。
--
-- 為什麼要有這個檔：關聯圖的規則是「匯合點的那一頭沒有任務可接就不畫點」
-- （見 AGENTS.md「關聯圖的匯合點兩頭都要接到任務」）。示範資料原本在
-- 系統遷移測試 ←同時完成→ 正式切換 後面沒有接任何東西，所以紫色匯合點
-- 永遠不會出現，等於示範不到「兩張任務 → 匯合點 → 一張任務」的樣子。
--
-- 為什麼中文放在 .sql 而不是 .bat：cmd.exe 會把批次檔裡的非 ASCII 吃掉
-- （`set X=中文` 會整行解析壞掉），這是這個專案踩過的坑。psql 讀檔時
-- cmd 不參與解析，所以中文一律放這裡。
--
-- 重跑安全：兩個 INSERT 都有 NOT EXISTS 擋著，跑第二次是 INSERT 0 0。

BEGIN;

-- 這一組「同時完成」的下游要掛在哪：找出 MRG 專案裡那條 FF 關聯，
-- 用它的目標端當定位點（不寫死任務編號 —— 全新安裝與他現在的資料庫編號不一樣）
CREATE TEMP TABLE anchor ON COMMIT DROP AS
SELECT t.id, t.workspace_id, t.project_id, t.parent_id, t.due_date, t.created_by
FROM task_link l
JOIN task t   ON t.id = l.target_id
JOIN project p ON p.id = t.project_id
WHERE p.key = 'MRG' AND l.link_type = 'FF' AND t.deleted_at IS NULL
LIMIT 1;

INSERT INTO task (workspace_id, project_id, number, parent_id, title, type,
                  status_key, start_date, due_date, progress, estimate_hours,
                  rank, created_by)
SELECT a.workspace_id, a.project_id,
       (SELECT coalesce(max(number), 0) + 1 FROM task WHERE project_id = a.project_id),
       a.parent_id, '切換後驗收', 'TASK', 'todo',
       a.due_date + 1, a.due_date + 4, 0, 32,
       (SELECT coalesce(max(rank), 0) + 1000 FROM task WHERE project_id = a.project_id),
       a.created_by
FROM anchor a
WHERE NOT EXISTS (
  SELECT 1 FROM task x
  WHERE x.project_id = a.project_id AND x.title = '切換後驗收' AND x.deleted_at IS NULL
);

-- 開出來的號碼不能跟之後手動新增的撞到
UPDATE project p
   SET next_number = greatest(p.next_number,
                              (SELECT coalesce(max(number), 0) + 1
                                 FROM task WHERE project_id = p.id))
 WHERE p.key = 'MRG';

-- 正式切換 →（完成後開始）→ 切換後驗收
INSERT INTO task_link (workspace_id, source_id, target_id, link_type, lag_days, created_by)
SELECT a.workspace_id, a.id, n.id, 'FS', 0, a.created_by
FROM anchor a
JOIN task n ON n.project_id = a.project_id
           AND n.title = '切換後驗收'
           AND n.deleted_at IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM task_link l
  WHERE l.source_id = a.id AND l.target_id = n.id AND l.link_type = 'FS'
);

-- 新任務掛上去了，祖先關係要跟著補
DELETE FROM task_closure;
INSERT INTO task_closure (ancestor_id, descendant_id, depth)
WITH RECURSIVE anc AS (
  SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth FROM task
  UNION ALL
  SELECT a.ancestor_id, t.id, a.depth + 1
    FROM anc a JOIN task t ON t.parent_id = a.descendant_id
)
SELECT ancestor_id, descendant_id, depth FROM anc;

COMMIT;

-- 跑完給人看的結果
SELECT p.key || '-' || s.number AS src, l.link_type,
       p.key || '-' || t.number AS tgt, s.title AS from_task, t.title AS to_task
  FROM task_link l
  JOIN task s    ON s.id = l.source_id
  JOIN task t    ON t.id = l.target_id
  JOIN project p ON p.id = s.project_id
 WHERE p.key = 'MRG' AND l.link_type IN ('FF', 'FS')
   AND (t.title = '切換後驗收' OR l.link_type = 'FF')
 ORDER BY l.link_type, s.number;
