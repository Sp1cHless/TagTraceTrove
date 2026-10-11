@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title SiteProbe - open every door and report

rem What this answers: "the tests passed, but is the tool actually working?"
rem
rem A test run imports library modules. A person opens batch files. This opens every
rem door the way a person does - through the interpreter the batch files use - with an
rem input that fails fast, and prints the outcome per door. It also audits the batch
rem files themselves: every script and module they name must exist.
rem
rem Nothing here touches the network beyond one refused connection, and nothing writes.
rem Exit: 0 = every door sound, 1 = something is broken (the lines marked FAIL).
rem
rem Add --slow to also open the two adapter builders. Each starts a browser, and each stops at
rem its annotation step by design ("opening the page (annotate)"), so a browser window is left
rem open the way those two doors always leave it - close it by hand when you are done.

where uv >nul 2>nul
if errorlevel 1 echo [WARN] uv not found; falling back to a plain python interpreter.

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media --extra dev
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

".venv\Scripts\python.exe" verify_doors.py %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Every door opened cleanly.
) else (
  echo [NOTE] A line marked FAIL above is the thing to fix; the audit half is static, so
  echo        it names the file and the line that is wrong.
)
pause
exit /b %EXIT_CODE%
