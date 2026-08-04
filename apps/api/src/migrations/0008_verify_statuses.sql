-- 任務狀態多兩欄：驗證中、驗證完成
--
-- 原本的流程是「待辦 → 進行中 → 待驗收 → 已完成」，中間那段太粗：
-- 東西交出去等人來驗、有人正在驗、驗過了但還沒收尾，這三件事都擠在「待驗收」，
-- 看板上根本分不出「還沒人動」跟「正在驗」。
--
--   待驗收   東西交出去了，等人來驗（沒人在動）
--   驗證中   有人正在驗
--   驗證完成 驗過了，等收尾／交付
--   已完成   結案
--
-- 驗證完成算 DONE：驗過了就不該再被算進「還沒做完」的數字裡，
-- 剩下的收尾動作是別人的事。已完成仍然留著，兩個都是 DONE 沒有問題。
--
-- 這裡把新狀態補給**既有的專案**，新開的專案走程式裡的預設清單
-- （routes/projects.ts 的 DEFAULT_STATUSES）。
-- 用 NOT EXISTS 而不是 ON CONFLICT：專案可能已經自己開了同名或同 key 的狀態，
-- 那是使用者的東西，不要覆蓋、也不要重複插一份。

INSERT INTO task_status (project_id, key, name, category, color, rank)
SELECT p.id, v.key, v.name, v.category, v.color, v.rank
FROM project p
CROSS JOIN (VALUES
  ('verifying', '驗證中',   'ACTIVE', '#8b5cf6', 3200),
  ('verified',  '驗證完成', 'DONE',   '#0d9488', 3500)
) AS v(key, name, category, color, rank)
WHERE NOT EXISTS (
  SELECT 1 FROM task_status s
  WHERE s.project_id = p.id AND (s.key = v.key OR s.name = v.name)
);
