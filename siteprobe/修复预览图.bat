@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Repair scrambled 18comic previews

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

echo Repairs previews downloaded before the restore hook existed.
echo Default is a dry run; nothing is written until you choose 2.
echo.
set "SCOPE=18comic_vip"
if not "%1"=="" set "SCOPE=%~1"
echo Scope: %SCOPE%
echo.
echo   1. dry run (list what would be repaired)
echo   2. apply (back up originals to _scramble_backup\ first)
set "CHOICE="
set /p "CHOICE=Number [1]: "
if "%CHOICE%"=="2" (
  ".venv\Scripts\python.exe" run_site_step.py 18comic.vip repair_scramble --export-scope "%SCOPE%" --export-root "{scope}" --apply
) else (
  ".venv\Scripts\python.exe" run_site_step.py 18comic.vip repair_scramble --export-scope "%SCOPE%" --export-root "{scope}"
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
