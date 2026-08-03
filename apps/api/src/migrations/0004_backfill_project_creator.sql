-- 補回沒有建立者的專案
--
-- 0002 加了 project.created_by，並且回填了「當時已經存在」的專案。
-- 漏掉的是那之後才產生的：示範資料的 INSERT 沒有填這一欄（seed.ts 已一併修正），
-- 所以 0002 之後才第一次啟動的站台，示範專案的 created_by 是 NULL ——
-- 沒有建立者就沒有人能核准加入申請，成員管理整條流程都會 403。
--
-- 跟 0002 用同一條規則：取最早的那個 MANAGER。uuidv7 是時間有序的，
-- 所以「user_id 最小」等於「最早建立的那個帳號」。

UPDATE project p SET created_by = (
  SELECT pm.user_id FROM project_member pm
  WHERE pm.project_id = p.id AND pm.role = 'MANAGER'
  ORDER BY pm.user_id
  LIMIT 1
) WHERE created_by IS NULL;
