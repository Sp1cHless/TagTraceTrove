@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Generic probe - build an adapter for a site

rem Give it a few works of ONE site. The first is annotated by choosing from the
rem candidates the tool found; the rest are confirmed, so you only say whether each
rem value it proposes is right. Then it writes a draft adapter, checks that the
rem existing runtime reads the same values, and installs it.
rem
rem Nothing is moved by hand: the pages are served on 127.0.0.1 and save their
rem result straight into the session folder.
rem
rem Usage:  build_adapter.bat <url> [<url>] [<url>]        (two or three is best)
rem Exit:   0 = the round trip agreed, 1 = it did not, 3 = no URL given.

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

set "FIRST=%~1"
if "%FIRST%"=="" set /p "FIRST=Paste the first work URL: "
if "%FIRST%"=="" (
  echo [ERROR] Nothing entered.
  pause
  exit /b 3
)

echo.
echo Two more works of the same site make the rules trustworthy; each one is a page
echo you confirm. Press Enter to skip the rest, or paste another URL.
echo.
set "SECOND=%~2"
if "%SECOND%"=="" set /p "SECOND=Second work URL (Enter to skip): "
set "THIRD=%~3"
if "%THIRD%"=="" if not "%SECOND%"=="" set /p "THIRD=Third work URL (Enter to skip): "

rem Each argument is quoted on its own line rather than collected into one string: a URL may
rem contain `&`, and inside a string built by `set` that character ends the command.
if "%THIRD%"=="" if "%SECOND%"=="" (
  ".venv\Scripts\python.exe" build_adapter.py --browser --install "%FIRST%"
) else if "%THIRD%"=="" (
  ".venv\Scripts\python.exe" build_adapter.py --browser --install "%FIRST%" "%SECOND%"
) else (
  ".venv\Scripts\python.exe" build_adapter.py --browser --install "%FIRST%" "%SECOND%" "%THIRD%"
)
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] The draft is installed and the runtime read the same values.
  echo      Try it with:  .venv\Scripts\python.exe probe.py "%FIRST%"
) else if "%EXIT_CODE%"=="1" (
  echo [NOTE] The runtime did not read what the annotation accepted, so nothing was
  echo        installed. The reasons are printed above, field by field.
) else (
  echo [ERROR] Nothing was built.
)
pause
exit /b %EXIT_CODE%
