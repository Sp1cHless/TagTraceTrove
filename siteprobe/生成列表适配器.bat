@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Generic probe - build an adapter for a listing

rem Give it ONE listing page: a search result, an artist page, a favourites folder.
rem It finds the repeated cards, lifts one out, and opens the annotation page where you
rem mark that card - the work's link, its title, its cover. Everything else is machinery:
rem the card becomes the row selector, the fields are learned the way a work's are, and
rem the second page (if you give one) is used to check that the ids are new ones.
rem
rem Paste a SECOND page of the same listing when you can - it is what checks that the
rem ids change from page to page, which is how a crawl knows when to stop.
rem
rem It shows the card groups it found and asks which one is the card, so nothing has to be
rem known before the run. The second URL must be the SAME listing's next page, not another
rem work of the site: a detail page is not a listing.
rem
rem Usage:  build_listing.bat <listing-url> [<page-2-url>]
rem Exit:   0 = the runtime read the cards back, 1 = it did not, 3 = no URL given.

where uv >nul 2>nul
if errorlevel 1 echo [WARN] uv not found; falling back to a plain python interpreter.

if not exist ".venv\Scripts\python.exe" (
  echo Preparing the environment for the first run ...
  uv sync --extra browser --extra media
  if errorlevel 1 (
    echo [ERROR] Environment setup failed.
    pause
    exit /b 1
  )
)

set "FIRST=%~1"
if "%FIRST%"=="" set /p "FIRST=Paste the listing URL: "
if "%FIRST%"=="" (
  echo [ERROR] Nothing entered.
  pause
  exit /b 3
)

set "SECOND=%~2"
if "%SECOND%"=="" set /p "SECOND=Second page of the same listing (Enter to skip): "

echo.
echo Page kind - what this page is, for the rule it generates. Enter for "search".
echo Common answers: search, artist, favorites, album, playlist.
set "KIND=%~3"
if "%KIND%"=="" set /p "KIND=Page kind [search]: "
if "%KIND%"=="" set "KIND=search"

echo.
rem Each argument is quoted on its own line rather than collected into one string: a URL may
rem contain `&`, and inside a string built by `set` that character ends the command. Measured
rem on a search page - `...?search_query=x&main_tag=2` - where the batch file tried to run
rem `main_tag=2` as a program and the tool was handed no URL at all.
if "%SECOND%"=="" (
  ".venv\Scripts\python.exe" build_listing.py --browser --install "--kind=%KIND%" "%FIRST%"
) else (
  ".venv\Scripts\python.exe" build_listing.py --browser --install "--kind=%KIND%" "%FIRST%" "%SECOND%"
)
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] The listing rule is installed and the runtime read the cards back.
  echo      Try it with:  probe.py ^<a listing URL of this site^>
) else if "%EXIT_CODE%"=="1" (
  echo [NOTE] The runtime read no cards from that page, so the rule is not right yet.
  echo        The [CHECK] lines above say which field or which id is the problem.
) else (
  echo [ERROR] Nothing was built.
)
pause
exit /b %EXIT_CODE%
