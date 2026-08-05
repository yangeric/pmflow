-- 任務種類的預設順序改成「大項目 → 任務 → 問題 → 里程碑」
--
-- 為什麼是這個順序：跟種類的上下關係同一個方向（大項目裝著任務、問題掛在任務
-- 底下），由大到小讀下來。里程碑排最後 —— 它不在這條包含鏈上，
-- 是插在時間軸上的一個點。原本的順序是「任務 → 里程碑 → 問題 → 大項目」，
-- 那是當初照 CHECK 裡的字面順序抄下來的，沒有想過。
--
-- 順序影響的不只是系統參數頁：所有種類下拉的排列、以及週檢視「依類型分組」
-- 時各組的先後，全部照這份 rank。所以要換就在這裡一次換完，
-- **不要在單一畫面裡另外寫一套排序** —— 那會跟其他下拉對不起來。
--
-- 只換「四種都還停在原本預設 rank」的專案。
-- 有人可能已經自己在系統參數頁把順序拖成他要的樣子了，那是使用者的東西，
-- 不可以覆蓋 —— 而「四個 rank 剛好等於 1000/2000/3000/4000 且各自對應原本那個
-- key」就是「沒有人動過」的證據。少了這個條件，這支 migration 會把每個人
-- 排好的順序洗掉一次，而且他不會知道發生了什麼事。
--
-- 專案自己新增的種類不動：它們的 rank 本來就落在別的位置，
-- 換完之後相對順序不變（新加的種類 rank 都大於 4000）。

UPDATE task_type t
SET rank = v.rank
FROM (VALUES
  ('EPIC',      1000),
  ('TASK',      2000),
  ('BUG',       3000),
  ('MILESTONE', 4000)
) AS v(key, rank)
WHERE t.key = v.key
  AND t.project_id IN (
    SELECT project_id
      FROM task_type
     WHERE key IN ('TASK', 'MILESTONE', 'BUG', 'EPIC')
     GROUP BY project_id
    HAVING count(*) = 4
       AND bool_and(
             (key = 'TASK'      AND rank = 1000) OR
             (key = 'MILESTONE' AND rank = 2000) OR
             (key = 'BUG'       AND rank = 3000) OR
             (key = 'EPIC'      AND rank = 4000)
           )
  );
