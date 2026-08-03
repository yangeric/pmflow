-- 專案成員：創立者核准制
--
-- 0001 的 project_member 只有「誰是成員」，沒有任何流程把人放進去 ——
-- 建立專案的人自動成為唯一的 MANAGER，其他帳號註冊後雖然進得了工作區，
-- 卻連專案存在都看不到。這裡補上兩件事：
--   1. 專案記得創立者是誰（授權的單一依據，不靠「誰是 MANAGER」推測）
--   2. 申請加入 → 創立者同意／婉拒的紀錄
--
-- 刻意把創立者獨立成欄位而不是沿用 MANAGER 角色：角色是「能做什麼」，
-- 可以有很多個；創立者是「這個專案是誰開的」，只有一個，而且轉移要留痕跡。

ALTER TABLE project ADD COLUMN created_by uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- 既有專案沒記創立者，取最早的那個 MANAGER 當作創立者。
-- project_member 當時沒有加入時間，只能用 user_id 排序 —— uuidv7 是時間有序的，
-- 所以這等於「最早建立的那個帳號」，對單一工作區的自架情境夠準。
UPDATE project p SET created_by = (
  SELECT pm.user_id FROM project_member pm
  WHERE pm.project_id = p.id AND pm.role = 'MANAGER'
  ORDER BY pm.user_id
  LIMIT 1
) WHERE created_by IS NULL;

-- 成員管理畫面要講「誰、什麼時候、被誰放進來的」
ALTER TABLE project_member ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE project_member ADD COLUMN added_by uuid REFERENCES app_user(id) ON DELETE SET NULL;

CREATE TABLE project_join_request (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  message      text,
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  -- 婉拒的理由要看得到，不然申請人只會收到一句「沒過」
  decided_note text,
  decided_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'PENDING' OR decided_at IS NOT NULL)
);

-- 同一個人對同一個專案同時只能有一筆待審。被婉拒之後可以再申請，
-- 所以條件只鎖 PENDING，不是整個 (project_id, user_id) 唯一。
CREATE UNIQUE INDEX ON project_join_request (project_id, user_id) WHERE status = 'PENDING';
CREATE INDEX ON project_join_request (project_id, status);
CREATE INDEX ON project_join_request (user_id, status);
