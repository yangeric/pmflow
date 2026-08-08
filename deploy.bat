@echo off
setlocal

REM PMFlow One-Click Deploy Script
REM Version: v0.2.3

set VERSION=0.2.3
set TAG=v0.2.3

cd /d "%~dp0"

echo.
echo ====================================
echo   PMFlow Auto Deploy %TAG%
echo ====================================
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :no_git

for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%i
if not "%BRANCH%"=="main" goto :not_main

echo [1/3] Checking working tree...
git status --porcelain | findstr /R "." >nul
if errorlevel 1 goto :clean_tree

echo Found uncommitted changes. Committing...
git add .
git commit -m "fix: update graph layout handle alignment release v0.2.3"
if errorlevel 1 goto :commit_failed

:clean_tree
echo.
echo [2/3] Pushing main branch...
git push origin main
if errorlevel 1 goto :push_failed

echo.
echo [3/3] Checking tag %TAG%...
git rev-parse -q --verify "refs/tags/%TAG%" >nul
if not errorlevel 1 goto :tag_exists

echo Creating and pushing tag %TAG%...
git tag -a "%TAG%" -m "PMFlow %TAG%"
git push origin "%TAG%"
if errorlevel 1 goto :tag_failed
goto :done

:tag_exists
echo Tag %TAG% already exists. Skipping tag creation.
goto :done

:no_git
echo [STOP] Not a git repository.
goto :hold

:not_main
echo [STOP] You are on branch "%BRANCH%". Releases are cut from main.
goto :hold

:commit_failed
echo [STOP] Commit failed.
goto :hold

:push_failed
echo [STOP] Git push failed.
goto :hold

:tag_failed
echo [WARNING] Could not push tag %TAG%.
goto :done

:done
echo.
echo ====================================
echo   Deployment triggered successfully!
echo ====================================
echo.
echo GitHub Actions build progress:
echo   https://github.com/yangeric/pmflow/actions
echo.
echo Docker images will be published at:
echo   ghcr.io/yangeric/pmflow-web:latest
echo   ghcr.io/yangeric/pmflow-api:latest
echo.

:hold
echo.
pause
