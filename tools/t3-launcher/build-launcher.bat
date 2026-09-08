@echo off
rem Build the T3 tray launcher and drop T3.exe at the repo root.
rem Framework-dependent single-file publish; needs the .NET SDK (dotnet on PATH).
setlocal
cd /d "%~dp0"
set PUB=dist

echo Publishing T3Launcher (Release, win-x64, framework-dependent single-file)...
dotnet publish T3Launcher.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o %PUB%
if errorlevel 1 (
  echo Publish failed.
  exit /b 1
)

rem Copy to the repo root next to T3.bat (launcher resolves paths from its own dir).
copy /y "%PUB%\T3Launcher.exe" "..\..\T3.exe" >nul
if errorlevel 1 (
  echo Copy failed.
  exit /b 1
)
rem Newer single-file SDKs embed runtimeconfig; copy it only when emitted.
if exist "%PUB%\T3Launcher.runtimeconfig.json" (
  copy /y "%PUB%\T3Launcher.runtimeconfig.json" "..\..\T3.runtimeconfig.json" >nul
  if errorlevel 1 (
    echo Runtimeconfig copy failed.
    exit /b 1
  )
)

echo.
echo Done: T3.exe is ready at the repo root. Double-click to start.
