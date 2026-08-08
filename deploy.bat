@echo off
setlocal

REM PMFlow Auto-Increment Release & Deploy Script (deploy.bat)
REM Automatically calculates the next patch version (e.g. v0.2.3 -> v0.2.4)

cd /d "%~dp0"

echo.
echo ====================================
echo   PMFlow Auto Deploy & Release
echo ====================================
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :no_git

for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%i
if not "%BRANCH%"=="main" goto :not_main

echo [1/4] Calculating next version tag...
for /f "usebackq tokens=*" %%V in (`powershell -Command "$tags = (git tag -l 'v*'); if (-not $tags) { 'v0.2.4' } else { $last = ($tags | Sort-Object { [version]($_ -replace 'v','') } | Select-Object -Last 1) -replace 'v',''; $p = $last.Split('.'); 'v' + $p[0] + '.' + $p[1] + '.' + ([int]$p[2] + 1) }"`) do set TAG=%%V

if "%TAG%"=="" set TAG=v0.2.4
set VERSION=%TAG:~1%

echo Next version tag: %TAG% (%VERSION%)

echo.
echo [2/4] Checking working tree...
git status --porcelain | findstr /R "." >nul
if errorlevel 1 goto :clean_tree

echo Found uncommitted changes. Committing...
git add .
git commit -m "release: %TAG% - update graph layout and seed data"
if errorlevel 1 goto :commit_failed

:clean_tree
echo.
echo [3/4] Pushing main branch to origin...
git push origin main
if errorlevel 1 goto :push_failed

echo.
echo [4/4] Creating and pushing tag %TAG%...
git tag -a "%TAG%" -m "PMFlow %TAG%"
git push origin "%TAG%"
if errorlevel 1 goto :tag_failed
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
echo   Successfully deployed release %TAG%!
echo ====================================
echo.
echo GitHub Actions build progress:
echo   https://github.com/yangeric/pmflow/actions
echo.
echo Published Docker image tags:
echo   ghcr.io/yangeric/pmflow-web:%VERSION%
echo   ghcr.io/yangeric/pmflow-api:%VERSION%
echo   ghcr.io/yangeric/pmflow-web:latest
echo   ghcr.io/yangeric/pmflow-api:latest
echo.

:hold
echo.
pause
