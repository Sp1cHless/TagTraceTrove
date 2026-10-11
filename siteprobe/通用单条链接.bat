@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Generic probe - any site: title + cover

rem Level 0. No site rule is used, so this accepts a link from ANY site, not only
rem the three that already have an adapter. It reports what it could read, says so
rem when a site needs a rule, and writes an export the library can import.
rem
rem Exit code: 0 = title + cover read and exported, 1 = page reached but not
rem readable without a rule, 2 = refused / blocked / unreachable, 3 = not a URL.

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

set "TARGET=%~1"
if "%TARGET%"=="" set /p "TARGET=Paste a work URL (any site): "
if "%TARGET%"=="" (
  echo [ERROR] Nothing entered.
  pause
  exit /b 3
)

echo.
".venv\Scripts\python.exe" show_link.py "%TARGET%"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo [OK] Title and cover were read, and the export above is ready to import.
) else if "%EXIT_CODE%"=="1" (
  echo [NOTE] The page was reached but not read fully - see RESULT above.
  echo        A "teaching" result means this site needs a rule to read it.
) else if "%EXIT_CODE%"=="2" (
  echo [NOTE] The page could not be read this time - refused, blocked or unreachable.
  echo        A "blocked" result means the site withheld it: a bot check or a login.
) else (
  echo [ERROR] The input was not an http or https URL, so there was nothing to fetch.
)
pause
exit /b %EXIT_CODE%
