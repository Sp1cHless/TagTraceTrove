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
set "T3_NETSTAT_FILE=%TEMP%\t3-netstat-%RANDOM%.txt"
netstat -ano > "%T3_NETSTAT_FILE%" 2>nul
findstr /r /c:":8765 .*LISTENING" "%T3_NETSTAT_FILE%" >nul 2>&1
set "T3_PORT_STATUS=%ERRORLEVEL%"
del "%T3_NETSTAT_FILE%" >nul 2>&1
if "%T3_PORT_STATUS%"=="0" (
  echo T3 is already running.
  if not "%T3_OPEN_BROWSER%"=="0" start "" http://127.0.0.1:8765
  exit /b 0
)

rem Prefer a Node runtime that can load this install's native SQLite module.
set "T3_NODE_EXE="
if exist "tools\node\node.exe" (
  "tools\node\node.exe" -e "const D=require('./apps/server/node_modules/better-sqlite3');new D(':memory:').close()" >nul 2>&1
  if not errorlevel 1 set "T3_NODE_EXE=%CD%\tools\node\node.exe"
)
if not defined T3_NODE_EXE if exist "%LOCALAPPDATA%\hermes\node\node.exe" (
  "%LOCALAPPDATA%\hermes\node\node.exe" -e "const D=require('./apps/server/node_modules/better-sqlite3');new D(':memory:').close()" >nul 2>&1
  if not errorlevel 1 set "T3_NODE_EXE=%LOCALAPPDATA%\hermes\node\node.exe"
)
if defined T3_NODE_EXE (
  for %%I in ("%T3_NODE_EXE%") do set "PATH=%%~dpI;%PATH%"
) else (
  node -e "const D=require('./apps/server/node_modules/better-sqlite3');new D(':memory:').close()" >nul 2>&1
  if errorlevel 1 (
    echo No compatible Node.js runtime was found for the installed SQLite module.
    pause
    exit /b 1
  )
)

rem Build the web app on first run, or when its sources are newer than the last
rem build: a stale dist/ silently serves old front-end code to the browser.
if not exist "apps\web\dist\index.html" (
  echo First run: building the web app...
  set "T3_WEB_BUILD=1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$dist = (Get-Item 'apps\web\dist\index.html').LastWriteTime; $newest = Get-ChildItem 'apps\web\src','apps\web\index.html','apps\web\vite.config.ts','apps\web\public','packages\shared\src' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($newest -and $newest.LastWriteTime -gt $dist) { exit 1 } else { exit 0 }"
  if errorlevel 1 (
    echo Web sources changed: rebuilding the web app...
    set "T3_WEB_BUILD=1"
  )
  rem Clear the PowerShell exit code so it cannot be mistaken for a build failure.
  ver >nul
)
if defined T3_WEB_BUILD (
  call npm exec --yes --package=pnpm@10.15.0 -- pnpm run build
  if errorlevel 1 (
    echo.
    echo Build failed - see the output above.
    pause
    exit /b 1
  )
)

cd apps\server
if not defined T3_OPEN_BROWSER set T3_OPEN_BROWSER=1
echo Starting T3 at http://127.0.0.1:8765
echo Close this window to stop the server.
call node_modules\.bin\tsx.cmd src\http\server-cli.ts
