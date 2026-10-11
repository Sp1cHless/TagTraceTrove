@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Generic probe - one link

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
if "%TARGET%"=="" set /p "TARGET=Paste a work, artist or collection URL (or a name): "
if "%TARGET%"=="" (
  echo [ERROR] Nothing entered.
  pause
  exit /b 2
)

echo.
".venv\Scripts\python.exe" probe.py "%TARGET%" %2 %3 %4 %5
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo [ERROR] Finished with code %EXIT_CODE%.
if "%EXIT_CODE%"=="0" echo Done. See the export\ folder.
pause
exit /b %EXIT_CODE%
