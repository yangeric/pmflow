-- PMFlow 初始 schema
-- 對應 docs/SPEC.md §5、§6

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- UUID v7：時間有序，索引比 v4 友善，且不洩漏總量。
-- PostgreSQL 18 才內建 uuidv7()，這裡自己補一個，PG 13+ 都能跑。
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
BEGIN
  RETURN encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1), 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

-- ─────────────────────────────────────────────────────────
-- 組織與帳號
-- ─────────────────────────────────────────────────────────
CREATE TABLE workspace (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  email             citext NOT NULL UNIQUE,
  password_hash     text,
  display_name      text NOT NULL,
  locale            text NOT NULL DEFAULT 'zh-TW',
  timezone          text NOT NULL DEFAULT 'Asia/Taipei',
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_member (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER','GUEST')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_token (user_id);
CREATE INDEX ON refresh_token (family_id);

-- ─────────────────────────────────────────────────────────
-- 專案
-- ─────────────────────────────────────────────────────────
CREATE TABLE project (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name         text NOT NULL,
  description  text,
  color        text NOT NULL DEFAULT '#3178c6',
  status       text NOT NULL DEFAULT 'ACTIVE',
  start_date   date,
  end_date     date,
  next_number  integer NOT NULL DEFAULT 1,
  rank         numeric NOT NULL DEFAULT 1000,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

CREATE TABLE project_member (
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('MANAGER','EDITOR','COMMENTER','VIEWER')),
  PRIMARY KEY (project_id, user_id)
);

-- 每個專案自己的狀態欄（看板的欄）
CREATE TABLE task_status (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  category   text NOT NULL DEFAULT 'ACTIVE' CHECK (category IN ('TODO','ACTIVE','DONE')),
  color      text NOT NULL DEFAULT '#94a3b8',
  rank       numeric NOT NULL,
  wip_limit  integer,
  UNIQUE (project_id, key)
);

-- ─────────────────────────────────────────────────────────
-- 任務
-- ─────────────────────────────────────────────────────────
CREATE TABLE task (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  parent_id         uuid REFERENCES task(id) ON DELETE SET NULL,
  title             text NOT NULL,
  description       text,
  type              text NOT NULL DEFAULT 'TASK'
                    CHECK (type IN ('TASK','MILESTONE','BUG','EPIC')),
  status_key        text NOT NULL DEFAULT 'todo',
  priority          text NOT NULL DEFAULT 'NORMAL'
                    CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  assignee_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  start_date        date,
  due_date          date,
  estimate_hours    numeric(8,2),
  spent_hours       numeric(8,2) NOT NULL DEFAULT 0,
  progress          smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  schedule_mode     text NOT NULL DEFAULT 'AUTO' CHECK (schedule_mode IN ('AUTO','MANUAL')),
  rank              numeric NOT NULL DEFAULT 1000,
  custom_fields     jsonb NOT NULL DEFAULT '{}',
  -- 跨單位發文追蹤的彙總欄位（衍生自 task_inquiry）
  inquiry_state     text NOT NULL DEFAULT 'NONE'
                    CHECK (inquiry_state IN ('NONE','AWAITING','OVERDUE','PARTIAL','REPLIED')),
  earliest_due_date date,
  created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (project_id, number),
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)
);
CREATE INDEX ON task (workspace_id, project_id, status_key) WHERE deleted_at IS NULL;
CREATE INDEX ON task (assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX ON task (project_id, rank);
CREATE INDEX ON task (parent_id);
CREATE INDEX ON task (workspace_id, inquiry_state)
  WHERE inquiry_state IN ('AWAITING','OVERDUE','PARTIAL');

-- 上下：階層閉包表。用空間換「一次查整棵子樹」的速度，
-- 甘特的父任務彙總（min start / max due / 加權完成率）每次重繪都要跑。
CREATE TABLE task_closure (
  ancestor_id   uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  descendant_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depth         integer NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX ON task_closure (descendant_id, depth);

-- 左右：單一邊表。排程類會推動日期，語意類只做關聯。
-- 只存正向一列，反向由查詢推導（Redmine / OpenProject 的作法）。
CREATE TABLE task_link (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  target_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  link_type    text NOT NULL CHECK (link_type IN
                 ('FS','SS','FF','SF','RELATES','BLOCKS','DUPLICATES','REQUIRES')),
  lag_days     integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  UNIQUE (source_id, target_id, link_type)
);
CREATE INDEX ON task_link (target_id, link_type);
CREATE INDEX ON task_link (source_id, link_type);

-- ─────────────────────────────────────────────────────────
-- 跨單位發文追蹤（SPEC §6）
-- 提問側與回覆側刻意分成兩組欄位：
-- 「發文給資訊部、實際是委外廠商回」在機關與大企業是常態。
-- ─────────────────────────────────────────────────────────
CREATE TABLE task_inquiry (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  task_id           uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  seq               smallint NOT NULL DEFAULT 1,

  -- 提問側
  asked_to_unit     text NOT NULL CHECK (btrim(asked_to_unit) <> ''),
  asked_to_person   text,
  asked_to_contact  text,
  asked_at          date NOT NULL DEFAULT CURRENT_DATE,
  due_date          date,
  question          text,
  asked_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,

  -- 回覆側（可能跟提問側不同單位）
  is_replied        boolean NOT NULL DEFAULT false,
  replied_by_unit   text,
  replied_by_person text,
  replied_at        date,
  reply_note        text,
  recorded_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CHECK (NOT is_replied OR replied_at IS NOT NULL),
  CHECK (replied_at IS NULL OR replied_at >= asked_at),
  CHECK (due_date IS NULL OR due_date >= asked_at)
);
CREATE INDEX ON task_inquiry (task_id, seq);
CREATE INDEX ON task_inquiry (workspace_id, asked_to_unit);
CREATE INDEX ON task_inquiry (workspace_id, replied_by_unit) WHERE replied_by_unit IS NOT NULL;
CREATE INDEX ON task_inquiry (workspace_id, due_date) WHERE NOT is_replied;

-- 單筆狀態不存欄位：逾期會隨日期自己改變，存了就得天天更新，
-- 而且一旦漏更新就顯示錯的東西。改成查詢時算。
CREATE VIEW v_inquiry AS
SELECT i.*,
       CASE WHEN i.is_replied              THEN 'REPLIED'
            WHEN i.due_date IS NULL        THEN 'AWAITING'
            WHEN i.due_date < CURRENT_DATE THEN 'OVERDUE'
            ELSE 'AWAITING' END                                   AS status,
       (CURRENT_DATE - i.asked_at)                                AS days_elapsed,
       CASE WHEN i.is_replied THEN (i.replied_at - i.asked_at) END AS days_to_reply,
       CASE WHEN NOT i.is_replied AND i.due_date < CURRENT_DATE
            THEN (CURRENT_DATE - i.due_date) END                  AS days_overdue
FROM task_inquiry i;

-- 單位是自由文字，沒有主檔。輸入時用這個 view 做 typeahead：
-- 不綁死使用者，又能讓「資訊部 / 資訊處 / IT」不那麼容易長成三個值。
CREATE VIEW v_unit_suggestion AS
SELECT workspace_id, unit,
       count(*)::int AS usage_count,
       max(used_on)  AS last_used_on
FROM (
  SELECT workspace_id, asked_to_unit AS unit, asked_at AS used_on
    FROM task_inquiry WHERE btrim(asked_to_unit) <> ''
  UNION ALL
  SELECT workspace_id, replied_by_unit, replied_at
    FROM task_inquiry WHERE btrim(coalesce(replied_by_unit,'')) <> ''
) t
GROUP BY workspace_id, unit;

-- ─────────────────────────────────────────────────────────
-- 活動日誌：留言與欄位異動同一張表，一次查詢就能畫出完整時間軸
-- ─────────────────────────────────────────────────────────
CREATE TABLE activity (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN
                 ('COMMENT','FIELD_CHANGE','LINK_CHANGE','INQUIRY_CHANGE','CREATED')),
  body         jsonb,
  actor_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_name   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity (task_id, created_at DESC);

CREATE TABLE label (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id uuid REFERENCES project(id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#64748b'
);

CREATE TABLE task_label (
  task_id  uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES label(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
