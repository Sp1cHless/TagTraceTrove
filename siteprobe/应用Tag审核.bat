@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Apply tag review

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

echo Which site? Leave blank to apply every site.
set "SITE_KEY="
set /p "SITE_KEY=Site key (e.g. hitomi.la, hanime1.me, 18comic.vip): "

echo.
echo Edit export^<site^>\tag_review.csv first: fill 'decision' with keep or block.
echo.
if "%SITE_KEY%"=="" (
  ".venv\Scripts\python.exe" tag_review.py
) else (
  ".venv\Scripts\python.exe" tag_review.py --site "%SITE_KEY%"
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
