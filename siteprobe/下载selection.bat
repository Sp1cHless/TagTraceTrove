@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Download the reviewed selection

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

if "%~1"=="" (
  echo Drag the review page's selection_*.json onto this BAT file.
  echo.
  echo   Example:
  echo     this-bat export\hitomi_la\artist_x\selection_x.json
  pause
  exit /b 2
)

".venv\Scripts\python.exe" selection.py %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo [ERROR] Finished with code %EXIT_CODE%.
if "%EXIT_CODE%"=="0" echo Done. See the export\ folder.
pause
exit /b %EXIT_CODE%
