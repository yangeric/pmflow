@echo off
setlocal
REM ============================================================
REM  PMFlow - release v0.1.4
REM
REM  Just double click this file. It will:
REM    1. push main
REM    2. create tag v0.1.4
REM    3. push the tag  -> GitHub Actions builds and publishes
REM
REM  The version is baked in. There is one of these per release;
REM  the previous one is deleted when the next is handed over.
REM
REM  Pure ASCII + CRLF on purpose - cmd.exe eats the first
REM  character of every line otherwise.
REM ============================================================

set "VERSION=0.1.4"
set "TAG=v%VERSION%"

cd /d "%~dp0"

echo.
echo   ====================================
echo     PMFlow  release  %TAG%
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
echo   (no leading v on the image tag - that is docker/metadata-action)
echo.

:hold
echo.
pause
