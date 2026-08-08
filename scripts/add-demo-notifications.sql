-- 產生未讀通知的測試資料，方便驗證任務閃紅框功能
BEGIN;

INSERT INTO notification (workspace_id, user_id, kind, actor_id, actor_name, project_id, task_id, body, created_at, read_at)
SELECT 
  t.workspace_id,
  u.id AS user_id,
  'TASK_ASSIGNED' AS kind,
  a.id AS actor_id,
  a.display_name AS actor_name,
  t.project_id,
  t.id AS task_id,
  jsonb_build_object('taskRef', p.key || '-' || t.number, 'taskTitle', t.title) AS body,
  now() AS created_at,
  NULL AS read_at
FROM task t
JOIN project p ON p.id = t.project_id
CROSS JOIN app_user u
JOIN LATERAL (
  SELECT id, display_name FROM app_user WHERE id <> u.id ORDER BY id LIMIT 1
) a ON true
WHERE t.deleted_at IS NULL
  AND t.number IN (4, 7, 9)
  AND NOT EXISTS (
    SELECT 1 FROM notification n 
    WHERE n.user_id = u.id 
      AND n.task_id = t.id 
      AND n.read_at IS NULL
  );

COMMIT;

-- 顯示結果
SELECT n.id, u.display_name AS recipient, n.kind, p.key || '-' || t.number AS task_ref, t.title AS task_title, n.read_at
FROM notification n
JOIN app_user u ON u.id = n.user_id
JOIN task t ON t.id = n.task_id
JOIN project p ON p.id = t.project_id
WHERE n.read_at IS NULL
ORDER BY n.created_at DESC;
