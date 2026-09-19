@echo off
rem Starts Mind Atlas: installs dependencies on first run, launches the API
rem and the web client in two windows, then opens the app in your browser.
rem Needs Node.js 18 or newer. Close the two windows to stop the app.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist "server\node_modules" call :install server
if not exist "client\node_modules" call :install client
start "MindAtlas API" cmd /k "cd /d %~dp0server && npm run dev"
start "MindAtlas client" cmd /k "cd /d %~dp0client && npm run dev"
timeout /t 8 /nobreak >nul
start "" http://localhost:5173
exit /b 0

:install
echo Installing %1 dependencies, this can take a minute...
pushd "%~dp0%1"
call npm install
popd
exit /b 0

:nonode
echo Node.js 18 or newer is required. Install it from https://nodejs.org and run this again.
pause
exit /b 1
