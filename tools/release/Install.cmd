@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -Start %*
set "T3_INSTALL_EXIT=%ERRORLEVEL%"
if not "%T3_INSTALL_EXIT%"=="0" pause
exit /b %T3_INSTALL_EXIT%
