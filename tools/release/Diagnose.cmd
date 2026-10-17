@echo off
setlocal
echo T3 independent diagnostics starting. Please keep this window open.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Diagnose.ps1" %*
set "T3_DIAG_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %T3_DIAG_EXIT%
