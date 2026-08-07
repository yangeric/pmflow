@echo off
setlocal
REM ============================================================
REM  PMFlow - release v0.2.1
REM
REM  Incremental release script:
REM    1. Push main branch
REM    2. Tag release v0.2.1
REM    3. Push tag v0.2.1 to GitHub Actions
REM
REM  Pure ASCII + CRLF for safe cmd.exe execution.
REM ============================================================

set "VERSION=0.2.1"
set "TAG=v%VERSION%"

cd /d "%~dp0"

echo.
echo   ====================================
echo     PMFlow release %TAG%
echo   ====================================
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo   [STOP] Not a git repository: %CD%
  goto :hold
)

for /f "delims=" %%i in ('git status --porcelain') do (
  echo   [STOP] There are uncommitted changes. Commit them first.
  echo.
  git status --short
  goto :hold
)

for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%i"
if not "%BRANCH%"=="main" (
  echo   [STOP] You are on branch "%BRANCH%". Releases are cut from main.
  goto :hold
)

git rev-parse -q --verify "refs/tags/%TAG%" >nul
if not errorlevel 1 (
  echo   [STOP] Tag %TAG% already exists.
  echo          Tags are never moved - ask for the next version.
  goto :hold
)

echo   Pushing main...
git push origin main
if errorlevel 1 (
  echo   [STOP] Could not push main.
  goto :hold
)

echo   Creating tag %TAG%...
git tag -a "%TAG%" -m "PMFlow %TAG%"
if errorlevel 1 goto :hold

echo   Pushing tag %TAG%...
git push origin "%TAG%"
if errorlevel 1 (
  echo   [STOP] Could not push the tag. Removing it locally again.
  git tag -d "%TAG%" >nul
  goto :hold
)

echo.
echo   Done. The build is running now:
echo     https://github.com/yangeric/pmflow/actions
echo.
echo   When it finishes the images are at:
echo     ghcr.io/yangeric/pmflow-api:%VERSION%
echo     ghcr.io/yangeric/pmflow-web:%VERSION%
echo.

:hold
echo.
pause
