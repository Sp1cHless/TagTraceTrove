@echo off
setlocal
cd /d "%~dp0"
title T3

rem ---------------------------------------------------------------
rem  T3 launcher - single-process production mode.
rem  Serves the app (API + web UI + media) from http://127.0.0.1:8765
rem  Close this window to stop the server.
rem  NOTE: keep this file plain ASCII (cmd/GBK cannot parse special chars).
rem  Starts via the local tsx.cmd (no npm exec / network needed).
rem ---------------------------------------------------------------

rem Already running? Just open the browser and exit.
netstat -ano | findstr /r ":8765 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo T3 is already running. Opening the browser...
  start "" http://127.0.0.1:8765
  exit /b 0
)

rem One-time build of the web app (only when dist is missing).
if not exist "apps\web\dist\index.html" (
  echo First run: building the web app...
  call npm exec --yes --package=pnpm@10.15.0 -- pnpm run build
  if errorlevel 1 (
    echo.
    echo Build failed - see the output above.
    pause
    exit /b 1
  )
)

cd apps\server
set T3_OPEN_BROWSER=1
echo Starting T3 at http://127.0.0.1:8765
echo Close this window to stop the server.
call node_modules\.bin\tsx.cmd src\http\server-cli.ts
