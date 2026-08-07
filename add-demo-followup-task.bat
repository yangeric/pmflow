@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  add-demo-followup-task.bat  --  give the "same finish" pair a downstream task
rem
rem  WHAT IT DOES
rem    The demo project MRG has a finish-together (FF) link between two
rem    tasks, but nothing came after them. The relation graph only draws
rem    the purple junction dot when its outer end reaches a real task
rem    (see AGENTS.md), so the demo data never showed what a junction
rem    looks like -- the pair fell back to a plain line.
rem
rem    This adds one downstream task under the same epic and links the
rem    FF target to it (finish-to-start). The graph then draws the full
rem    shape: two tasks -> junction dot -> one task.
rem
rem    seed.ts already contains this task, so a FRESH database gets it
rem    automatically. This script is only for databases created before
rem    2026-08-06 that already hold data worth keeping.
rem
rem  SAFE TO RUN TWICE
rem    Yes. Both inserts are guarded by NOT EXISTS and the whole thing
rem    runs in one transaction, so a second run prints INSERT 0 0 and
rem    changes nothing. A failed run rolls back and can just be re-run.
rem
rem  WHY THE SQL LIVES IN A SEPARATE FILE
rem    cmd.exe mangles non-ASCII inside .bat files (a `set X=<chinese>`
rem    line breaks parsing outright -- this bit us once already). The
rem    batch file stays pure ASCII; every Chinese literal lives in
rem    scripts\add-demo-followup-task.sql, which cmd never parses.
rem
rem  REQUIRES the dev stack to be up:
rem    docker compose -f docker-compose.dev.yml up -d
rem ============================================================

cd /d "%~dp0"

set COMPOSE=docker compose -f docker-compose.dev.yml
set SQLFILE=%~dp0scripts\add-demo-followup-task.sql

if not exist "%SQLFILE%" (
  echo FAILED. Cannot find %SQLFILE%
  exit /b 1
)

echo.
echo === Applying scripts\add-demo-followup-task.sql ===
%COMPOSE% exec -T db psql -U pmflow -d pmflow -v ON_ERROR_STOP=1 < "%SQLFILE%"
if errorlevel 1 goto :failed

echo.
echo Done. Open the relation graph and look for the purple junction dot.
goto :eof

:failed
echo.
echo FAILED. Is the dev stack running?
echo   docker compose -f docker-compose.dev.yml up -d
exit /b 1
