@echo off
setlocal
rem Transfer to the retained root entry when invoked from a version folder.
if exist "%~dp0installed.json" if exist "%~dp0..\..\installation.json" "%~dp0..\..\Uninstall.cmd" %*
cd /d "%TEMP%"
rem Parse the entire final block before the version folder can be removed.
(
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1" %*
  if errorlevel 1 (
    pause
    exit /b 1
  )
  pause
  exit /b 0
)
