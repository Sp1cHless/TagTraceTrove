@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title SiteProbe - sign a site in once

rem The one part of this tool that needs a person: a site whose crawl needs a signed-in session
rem (18comic's favourites). A browser window opens on the site's front page; sign in or clear the
rem site's own check there, and then say you are done - by pressing Enter in THIS window, or, when
rem T3 started this bat, by pressing "I have signed in" on its page, which answers the very same
rem wait. The session is then written to the profile the adapter reads; the tool never sees a
rem password and never stores one.
rem
rem Pass --no-pause as the only argument when nobody is watching this window, which is what T3
rem does: a pause under a pipe never returns, and a finished sign-in then looked like a stuck tool.
rem
rem Exit code: 0 = session written, 2 = no adapter for that input, 1 = browser or write failed.

where uv >nul 2>nul
if errorlevel 1 echo [WARN] uv not found; falling back to a plain python interpreter.

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

rem The address comes from the environment when T3 started this bat: `cmd` splits batch
rem arguments on `=`, and a favourite or search address always carries one
rem (`...?folder=4717648` arrived as two arguments, which also hid the flag below).
set "TARGET=%SITEPROBE_LOGIN_TARGET%"
if "%TARGET%"=="" set "TARGET=%~1"
if "%TARGET%"=="" set /p "TARGET=Paste a URL of the site to sign in to (or its key): "
if "%TARGET%"=="" (
  echo [ERROR] Nothing entered.
  pause
  exit /b 2
)

echo.
".venv\Scripts\python.exe" login.py "%TARGET%"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo [OK] The session was written. The crawl of this site can use it now.
) else if "%EXIT_CODE%"=="2" (
  echo [NOTE] No adapter claims that input - see the message above.
) else (
  echo [ERROR] The browser could not be opened, or the session could not be written.
)

if not "%~1"=="--no-pause" pause
exit /b %EXIT_CODE%
