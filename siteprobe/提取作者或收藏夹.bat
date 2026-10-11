@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Generic probe - author or collection

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

rem The site menu is produced from tool/*/site.json, so a site added later shows
rem up here without this file changing.
".venv\Scripts\python.exe" pick.py
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo [ERROR] Finished with code %EXIT_CODE%.
if "%EXIT_CODE%"=="0" echo Done. See the export\ folder.
pause
exit /b %EXIT_CODE%
