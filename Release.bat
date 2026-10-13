@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\release\release.ps1" %*
set "T3_RELEASE_EXIT=%ERRORLEVEL%"
if not "%T3_RELEASE_EXIT%"=="0" echo Release failed. See the error above.
pause
exit /b %T3_RELEASE_EXIT%
