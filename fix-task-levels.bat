@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  fix-task-levels.bat  --  put stray top-level tasks under an epic
rem
rem  WHY
rem    Only epics belong at the top level (see AGENTS.md, "task kinds and
rem    what they may hang under"). A task sitting there is drawn as if it
rem    were an epic in the sidebar, so the tree on the left stops matching
rem    the real structure. Data created before that rule exists breaks it.
rem
rem  WHAT IT DOES
rem    For every project that has EXACTLY ONE epic, every top-level task
rem    or milestone is moved under that epic. Then the closure table is
rem    rebuilt for that project -- moving a row without rebuilding it
rem    leaves the graph and the parent roll-ups reading stale ancestry.
rem
rem  WHAT IT REFUSES TO GUESS
rem    * A project with no epic, or with several -- there is no single
rem      right answer, so it is listed and left alone.
rem    * An error (BUG) that is not under a task. Which task it belongs to
rem      is a judgement call; moving it somewhere arbitrary is worse than
rem      leaving it visible and wrong.
rem    Sub-tasks are NOT touched: a task under another task is legal.
rem
rem  SAFE TO RUN AGAIN
rem    It only moves rows that are still at the top level, so a second run
rem    moves nothing. Everything happens in one transaction.
rem
rem  REQUIRES the dev stack to be up:
rem    docker compose -f docker-compose.dev.yml up -d
rem ============================================================

cd /d "%~dp0"

set COMPOSE=docker compose -f docker-compose.dev.yml
set PSQL=%COMPOSE% exec -T db psql -U pmflow -d pmflow -v ON_ERROR_STOP=1

echo.
echo === Projects with exactly one epic (these can be fixed) ===
%PSQL% -c "SELECT p.key, count(*) FILTER (WHERE t.type = 'EPIC' AND t.parent_id IS NULL) AS epics, count(*) FILTER (WHERE t.type <> 'EPIC' AND t.parent_id IS NULL) AS strays FROM project p JOIN task t ON t.project_id = p.id AND t.deleted_at IS NULL GROUP BY p.key ORDER BY p.key;"
if errorlevel 1 goto :failed

echo.
echo === Moving ===
%PSQL% -c "WITH lone AS (SELECT project_id, (array_agg(id ORDER BY number))[1] AS epic_id FROM task WHERE deleted_at IS NULL AND type = 'EPIC' AND parent_id IS NULL GROUP BY project_id HAVING count(*) = 1) UPDATE task t SET parent_id = lone.epic_id, updated_at = now() FROM lone WHERE t.project_id = lone.project_id AND t.deleted_at IS NULL AND t.parent_id IS NULL AND t.type <> 'EPIC';"
if errorlevel 1 goto :failed

echo.
echo === Rebuilding the closure table for every project that changed ===
%PSQL% -c "DELETE FROM task_closure;"
if errorlevel 1 goto :failed
%PSQL% -c "INSERT INTO task_closure (ancestor_id, descendant_id, depth) WITH RECURSIVE anc AS (SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth FROM task UNION ALL SELECT a.ancestor_id, t.id, a.depth + 1 FROM anc a JOIN task t ON t.parent_id = a.descendant_id) SELECT ancestor_id, descendant_id, depth FROM anc;"
if errorlevel 1 goto :failed

echo.
echo === Still wrong, needs a human decision ===
%PSQL% -c "SELECT p.key || '-' || t.number AS ref, t.title, t.type, COALESCE(pa.type, '(top level)') AS parent_kind FROM task t JOIN project p ON p.id = t.project_id LEFT JOIN task pa ON pa.id = t.parent_id WHERE t.deleted_at IS NULL AND ((t.type IN ('TASK','MILESTONE') AND t.parent_id IS NULL) OR (t.type = 'BUG' AND (pa.id IS NULL OR pa.type <> 'TASK')) OR (t.type = 'EPIC' AND pa.id IS NOT NULL AND pa.type <> 'EPIC')) ORDER BY p.key, t.number;"
if errorlevel 1 goto :failed

echo.
echo Done. Reload the page to see it.
goto :eof

:failed
echo.
echo FAILED. Is the dev stack running?
echo   docker compose -f docker-compose.dev.yml up -d
exit /b 1
