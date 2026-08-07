@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  fix-web-aaa.bat  --  turn WEB-1 "AAA" into an epic
rem
rem  WHY
rem    Only epics belong at the top level (see AGENTS.md, "task kinds and
rem    what they may hang under"). WEB-1 is a task sitting at the top of
rem    the WEB project, so the sidebar draws it as if it were an epic and
rem    the tree on the left stops matching the real structure. The chosen
rem    fix is to change WEB-1 itself into an epic -- NOT to invent a new
rem    epic above it.
rem
rem  WHAT IT DOES
rem    1. Reads the current kind of WEB-1 and prints it.
rem    2. If it is already an epic, prints "already an epic, skipping"
rem       and stops. Nothing is written.
rem    3. Otherwise sets task.type = 'EPIC' and recomputes the closure
rem       table for the WEB project, both inside ONE transaction.
rem    4. Prints what WEB-1 looks like afterwards, plus anything left in
rem       the project that still breaks the rules.
rem
rem  WHAT IT REFUSES TO DO
rem    * WEB-1 hanging under something that is not an epic -- an epic may
rem      only sit at the top level or under another epic, so the move
rem      would just swap one broken row for another.
rem    * WEB-1 having an error (BUG) directly under it -- an error's
rem      parent must be a task, so turning its parent into an epic would
rem      orphan it. Move those errors first.
rem    Both are also written into the UPDATE itself, so the script cannot
rem    do the wrong thing even if the pre-check is skipped.
rem
rem  SAFE TO RUN AGAIN
rem    Yes. The UPDATE only matches rows whose kind is still not 'EPIC',
rem    so a second run reports 0 rows and changes nothing. The closure
rem    rebuild only touches the WEB project and produces the same rows
rem    every time. Everything happens in one transaction, so a failure
rem    half way through leaves the database exactly as it was and the
rem    script can simply be run again.
rem
rem  REQUIRES the dev stack to be up:
rem    docker compose -f docker-compose.dev.yml up -d
rem ============================================================

cd /d "%~dp0"

set COMPOSE=docker compose -f docker-compose.dev.yml
set PSQL=%COMPOSE% exec -T db psql -U pmflow -d pmflow -v ON_ERROR_STOP=1
rem Same thing, one value per line, for reading a single answer back into a
rem variable. It deliberately drops -v ON_ERROR_STOP=1: inside a FOR /F the
rem shell turns that "=" into a space, psql then reads the 1 as a stray
rem argument and warns about it on every run.
set PSQLQ=%COMPOSE% exec -T db psql -U pmflow -d pmflow -tA

rem Which task to fix. Project key + number, because task has no code column.
set PKEY=WEB
set PNUM=1
set WHERE=p.key = '%PKEY%' AND t.number = %PNUM% AND t.deleted_at IS NULL

echo.
echo === The task we are about to change ===
%PSQL% -c "SELECT p.key || '-' || t.number AS ref, t.title, t.type AS kind, COALESCE(pa.type, '(top level)') AS parent_kind FROM task t JOIN project p ON p.id = t.project_id LEFT JOIN task pa ON pa.id = t.parent_id WHERE %WHERE%;"
if errorlevel 1 goto :failed

set CURTYPE=
for /f "usebackq tokens=*" %%t in (`%PSQLQ% -c "SELECT t.type FROM task t JOIN project p ON p.id = t.project_id WHERE %WHERE%;"`) do set CURTYPE=%%t

if "%CURTYPE%"=="" goto :notfound
if "%CURTYPE%"=="EPIC" goto :already

echo.
echo === Checking it is safe to change (kind is now %CURTYPE%) ===
set BLOCKERS=
for /f "usebackq tokens=*" %%n in (`%PSQLQ% -c "SELECT (SELECT count(*) FROM task t JOIN project p ON p.id = t.project_id JOIN task pa ON pa.id = t.parent_id WHERE %WHERE% AND pa.type <> 'EPIC') + (SELECT count(*) FROM task t JOIN project p ON p.id = t.project_id JOIN task c ON c.parent_id = t.id AND c.deleted_at IS NULL WHERE %WHERE% AND c.type = 'BUG');"`) do set BLOCKERS=%%n

if "%BLOCKERS%"=="" goto :failed
if not "%BLOCKERS%"=="0" goto :blocked

echo   nothing in the way.

echo.
echo === Changing the kind and recomputing the closure table ===
rem One -c string = one transaction. Both statements land together or not at all.
%PSQL% -c "UPDATE task t SET type = 'EPIC', updated_at = now() FROM project p WHERE p.id = t.project_id AND %WHERE% AND t.type <> 'EPIC' AND NOT EXISTS (SELECT 1 FROM task pa WHERE pa.id = t.parent_id AND pa.type <> 'EPIC') AND NOT EXISTS (SELECT 1 FROM task c WHERE c.parent_id = t.id AND c.deleted_at IS NULL AND c.type = 'BUG'); DELETE FROM task_closure c USING task t, project p WHERE c.descendant_id = t.id AND t.project_id = p.id AND p.key = '%PKEY%'; INSERT INTO task_closure (ancestor_id, descendant_id, depth) WITH RECURSIVE anc AS (SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth FROM task UNION ALL SELECT a.ancestor_id, t.id, a.depth + 1 FROM anc a JOIN task t ON t.parent_id = a.descendant_id) SELECT a.ancestor_id, a.descendant_id, a.depth FROM anc a JOIN task t ON t.id = a.descendant_id JOIN project p ON p.id = t.project_id WHERE p.key = '%PKEY%' ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;"
if errorlevel 1 goto :failed
goto :report

:already
echo.
echo   WEB-%PNUM% is already an epic, skipping. Nothing was written.
goto :report

:report
echo.
echo === WEB-%PNUM% now ===
%PSQL% -c "SELECT p.key || '-' || t.number AS ref, t.title, t.type AS kind, COALESCE(pa.type, '(top level)') AS parent_kind FROM task t JOIN project p ON p.id = t.project_id LEFT JOIN task pa ON pa.id = t.parent_id WHERE %WHERE%;"
if errorlevel 1 goto :failed

echo.
echo === Anything left in %PKEY% that still breaks the rules ===
echo (empty is good)
%PSQL% -c "SELECT p.key || '-' || t.number AS ref, t.title, t.type AS kind, COALESCE(pa.type, '(top level)') AS parent_kind FROM task t JOIN project p ON p.id = t.project_id LEFT JOIN task pa ON pa.id = t.parent_id WHERE p.key = '%PKEY%' AND t.deleted_at IS NULL AND ((t.type IN ('TASK','MILESTONE') AND t.parent_id IS NULL) OR (t.type = 'BUG' AND (pa.id IS NULL OR pa.type <> 'TASK')) OR (t.type = 'EPIC' AND pa.id IS NOT NULL AND pa.type <> 'EPIC')) ORDER BY t.number;"
if errorlevel 1 goto :failed

echo.
echo === Scheduling links that now cross an epic and a task ===
echo (empty is good -- an epic contains tasks, it does not come before them)
%PSQL% -c "SELECT p.key || '-' || s.number || ' -> ' || p.key || '-' || g.number AS link, l.link_type AS kind, s.type AS source_kind, g.type AS target_kind FROM task_link l JOIN task s ON s.id = l.source_id JOIN task g ON g.id = l.target_id JOIN project p ON p.id = s.project_id WHERE p.key = '%PKEY%' AND l.link_type IN ('FS','SS','FF','SF') AND ((s.type = 'EPIC') <> (g.type = 'EPIC')) ORDER BY s.number;"
if errorlevel 1 goto :failed

echo.
echo Done. Reload the page to see it.
goto :eof

:notfound
echo.
echo FAILED. No live task %PKEY%-%PNUM% found.
echo   Is the dev stack running, and does the %PKEY% project still exist?
exit /b 1

:blocked
echo.
echo REFUSED. %BLOCKERS% thing(s) are in the way -- see below.
%PSQL% -c "SELECT 'parent is not an epic' AS reason, COALESCE(pa.type, '(top level)') AS detail FROM task t JOIN project p ON p.id = t.project_id JOIN task pa ON pa.id = t.parent_id WHERE %WHERE% AND pa.type <> 'EPIC' UNION ALL SELECT 'error hanging directly under it', p.key || '-' || c.number || ' ' || c.title FROM task t JOIN project p ON p.id = t.project_id JOIN task c ON c.parent_id = t.id AND c.deleted_at IS NULL WHERE %WHERE% AND c.type = 'BUG';"
echo.
echo Nothing was written. Move those rows first, then run this again.
exit /b 1

:failed
echo.
echo FAILED. Is the dev stack running?
echo   docker compose -f docker-compose.dev.yml up -d
exit /b 1
