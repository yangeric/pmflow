-- 任務種類 BUG 的名字改成：「問題」
UPDATE task_type
   SET name = '問題'
 WHERE key = 'BUG'
   AND name IN ('錯誤', '缺陷');
