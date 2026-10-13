@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -Port 8785 -TlsPort 8786 -InstanceName Demo -Start %*
set "T3_DEMO_EXIT=%ERRORLEVEL%"
if not "%T3_DEMO_EXIT%"=="0" pause
exit /b %T3_DEMO_EXIT%
