@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  clean-demo-junk.bat  --  remove throwaway tasks from the dev database
rem
rem  WHAT IT DOES
rem    Soft-deletes the hand-typed test tasks that pile up in the demo
rem    project while clicking around ("111", "1111", "31321", "23424").
rem    Soft delete = sets deleted_at, exactly what the app's own delete
rem    button does. Nothing is erased; the rows stay in the database.
rem
rem  SAFE TO RUN AGAIN
rem    Already-deleted tasks are skipped, so a second run reports 0 and
rem    changes nothing. It also refuses to touch a task that has any
rem    task link, any outside enquiry, or more than one activity row --
rem    that is the sign somebody actually used it, junk never has those.
rem    Field changes do NOT count -- flipping a status or a kind while
rem    poking around is exactly what happens to a throwaway task.
rem
rem  WHAT IT LEAVES ALONE
rem    MRG-13 / MRG-14 look like duplicates of MRG-9 / MRG-10 but they
rem    carry task links, so removing them would break the demo graph.
rem    MRG-15 is the API-token demo task and is referenced in the docs.
rem    Both are deliberate -- widen TITLES below if you disagree.
rem
rem  REQUIRES the dev stack to be up:
rem    docker compose -f docker-compose.dev.yml up -d
rem ============================================================

cd /d "%~dp0"

set COMPOSE=docker compose -f docker-compose.dev.yml
set PSQL=%COMPOSE% exec -T db psql -U pmflow -d pmflow -v ON_ERROR_STOP=1

rem Titles treated as throwaway. Quote each one, comma separated.
set TITLES='111','1111','31321','23424'

echo.
echo === Tasks that will be removed ===
%PSQL% -c "SELECT p.key || '-' || t.number AS ref, t.title FROM task t JOIN project p ON p.id = t.project_id WHERE t.deleted_at IS NULL AND t.title IN (%TITLES%) AND NOT EXISTS (SELECT 1 FROM task_link l WHERE l.source_id = t.id OR l.target_id = t.id) AND NOT EXISTS (SELECT 1 FROM task_inquiry i WHERE i.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.task_id = t.id AND a.kind = 'COMMENT') ORDER BY t.number;"
if errorlevel 1 goto :failed

echo.
echo === Removing ===
%PSQL% -c "UPDATE task t SET deleted_at = now(), updated_at = now() WHERE t.deleted_at IS NULL AND t.title IN (%TITLES%) AND NOT EXISTS (SELECT 1 FROM task_link l WHERE l.source_id = t.id OR l.target_id = t.id) AND NOT EXISTS (SELECT 1 FROM task_inquiry i WHERE i.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.task_id = t.id AND a.kind = 'COMMENT');"
if errorlevel 1 goto :failed

echo.
echo === Remaining live tasks per project ===
%PSQL% -c "SELECT p.key, count(*) AS live_tasks FROM task t JOIN project p ON p.id = t.project_id WHERE t.deleted_at IS NULL GROUP BY p.key ORDER BY p.key;"
if errorlevel 1 goto :failed

echo.
echo Done. Reload the page to see it.
goto :eof

:failed
echo.
echo FAILED. Is the dev stack running?
echo   docker compose -f docker-compose.dev.yml up -d
exit /b 1
