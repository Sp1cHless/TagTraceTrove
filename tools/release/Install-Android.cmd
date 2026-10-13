@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Android.ps1" %*
set "T3_ANDROID_EXIT=%ERRORLEVEL%"
pause
exit /b %T3_ANDROID_EXIT%
