@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  PMFlow - one-click start for Windows
REM  Requires: Docker Desktop (nothing else - no Node, no Postgres)
REM
REM  NOTE FOR MAINTAINERS: keep this file PURE ASCII with CRLF
REM  line endings. cmd.exe re-seeks by byte offset and will
REM  corrupt parsing if this file contains non-ASCII characters.
REM ============================================================

cd /d "%~dp0"

echo.
echo   PMFlow
echo   ------------------------------------------------

if not exist "docker-compose.dev.yml" (
  echo   [X] docker-compose.dev.yml not found.
  echo       Run this script from inside the pmflow folder.
  echo       Current folder: %CD%
  echo.
  pause
  exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
  echo   [X] Docker not found on this machine.
  echo.
  echo       Install Docker Desktop, then run this again:
  echo       https://www.docker.com/products/docker-desktop/
  echo.
  echo       If Docker IS installed, close this window and
  echo       open a NEW terminal so PATH is refreshed.
  echo.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo   [X] Docker Desktop is installed but not running.
  echo       Start Docker Desktop, wait for the whale icon to
  echo       turn green, then run this again.
  echo.
  pause
  exit /b 1
)

echo   Starting... first run builds images (3-5 minutes).
echo.

docker compose -f docker-compose.dev.yml up --build -d
if errorlevel 1 (
  echo.
  echo   [X] Startup failed. See the error above.
  echo       Common cause: port 8480 already in use.
  echo       Check with:  netstat -ano ^| findstr :8480
  echo       Change port: set HTTP_PORT=9480 then run again
  echo.
  pause
  exit /b 1
)

echo.
echo   Waiting for services to become ready...
set READY=0
for /l %%i in (1,1,90) do (
  if !READY! equ 0 (
    timeout /t 2 >nul
    curl -sf http://localhost:8480/health >nul 2>&1 && set READY=1
  )
)

echo.
if !READY! equ 1 (
  echo   ================================================
  echo     PMFlow is running:  http://localhost:8480
  echo.
  echo     Demo account:  demo@pmflow.local
  echo     Password:      demo1234
  echo   ================================================
) else (
  echo   [!] Containers started but health check timed out.
  echo       Check the logs:
  echo       docker compose -f docker-compose.dev.yml logs -f
)

echo.
echo   Stop:      docker compose -f docker-compose.dev.yml down
echo   Reset all: docker compose -f docker-compose.dev.yml down -v
echo   Logs:      docker compose -f docker-compose.dev.yml logs -f
echo.

if !READY! equ 1 start "" http://localhost:8480
pause
endlocal
