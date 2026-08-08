@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  add-demo-notifications.bat -- 產生未讀通知測試資料
rem ============================================================

cd /d "%~dp0"

set COMPOSE=docker compose -f docker-compose.dev.yml
set SQLFILE=%~dp0scripts\add-demo-notifications.sql

if not exist "%SQLFILE%" (
  echo FAILED. Cannot find %SQLFILE%
  exit /b 1
)

echo.
echo === Inserting unread demo notifications ===
%COMPOSE% exec -T db psql -U pmflow -d pmflow -v ON_ERROR_STOP=1 < "%SQLFILE%"
if errorlevel 1 goto :failed

echo.
echo Done. Unread demo notifications inserted!
goto :eof

:failed
echo.
echo FAILED. Is docker running?
exit /b 1
