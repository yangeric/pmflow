@echo off
setlocal
REM ============================================================
REM  PMFlow - Fast Git Commit & Push Script
REM
REM  Pure ASCII + CRLF on purpose so cmd.exe parses safely.
REM ============================================================

cd /d "%~dp0"

echo.
echo   ====================================
echo     PMFlow - Git Commit and Push
echo   ====================================
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo   [STOP] Not a git repository: %CD%
  goto :hold
)

for /f "delims=" %%i in ('git status --porcelain') do set "HAS_CHANGES=1"

if not defined HAS_CHANGES (
  echo   [INFO] No changes to commit. Working tree clean.
  goto :push
)

echo   Changes detected:
git status --short
echo.

set /p MSG="Enter commit message (or press ENTER for default 'update'): "
if "%MSG%"=="" set "MSG=update"

echo.
echo   Adding files...
git add .

echo   Committing: "%MSG%"...
git commit -m "%MSG%"
if errorlevel 1 (
  echo   [STOP] Commit failed.
  goto :hold
)

:push
echo.
echo   Pushing to origin main...
git push origin main
if errorlevel 1 (
  echo   [STOP] Git push failed.
  goto :hold
)

echo.
echo   ====================================
echo     Successfully pushed to main!
echo   ====================================
echo.

:hold
echo.
pause
