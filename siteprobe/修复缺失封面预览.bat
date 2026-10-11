@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Repair missing covers and previews

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

set "SCOPE=18comic_vip"
if not "%~1"=="" set "SCOPE=%~1"
echo Scope: %SCOPE%
echo.
echo   1. dry run (list what is missing)
echo   2. apply (download the missing files)
set "CHOICE="
set /p "CHOICE=Number [1]: "
if "%CHOICE%"=="2" (
  ".venv\Scripts\python.exe" repair_media.py "%SCOPE%" --apply
) else (
  ".venv\Scripts\python.exe" repair_media.py "%SCOPE%"
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
