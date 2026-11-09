@echo off
rem Automatic webpe lookup on the lab laptop (see README.md, "Automatic lookup").
rem Opens Edge with its own profile and local-only remote debugging on two tabs (DCIM and webpe), then runs
rem "node sync.cjs --watch": every unit added with a serial number and no P/N gets its P/N, model and name from webpe.
rem   start-webpe-sync.cmd                    start (Edge, if it is not open yet, and the lookup)
rem   start-webpe-sync.cmd --install-startup  also start it at every sign-in to Windows (a shortcut in the Startup folder)
rem Settings (optional): DCIM_URL (default: vm_site in .team\ops\release.local.json), WEBPE_PAGE (the SN analysis page),
rem WEBPE_INTERVAL (seconds between checks, default 20), WEBPE_CDP_PORT (Edge remote debugging port, default 9333).
setlocal EnableExtensions
set "HERE=%~dp0"
set "SELF=%~f0"
if not defined WEBPE_CDP_PORT set "WEBPE_CDP_PORT=9333"
set "PORT=%WEBPE_CDP_PORT%"
set "WEBPE_CDP=http://127.0.0.1:%PORT%"
set "PROFILE_DIR=%LOCALAPPDATA%\webpe-profile"
set "TOOLS_DIR=%LOCALAPPDATA%\webpe-sync\node"
if not defined WEBPE_PAGE set "WEBPE_PAGE=https://webpe.nvidia.com/"
title webpe auto lookup

if /i "%~1"=="--install-startup" call :install || exit /b 1

where node >nul 2>nul || (echo Node.js is needed: install it from https://nodejs.org and run this again.& pause & exit /b 1)
if not defined DCIM_URL for /f "usebackq delims=" %%u in (`node -e "try{process.stdout.write(String(require(process.argv[1]).vm_site||''))}catch(e){}" "%HERE%..\..\.team\ops\release.local.json"`) do set "DCIM_URL=%%u"
if not defined DCIM_URL (echo Set the DCIM site address first, for example:  setx DCIM_URL https://your-dcim-site & pause & exit /b 1)

rem Playwright's library (no browser download) for sync.cjs, kept outside the repository.
set "NODE_PATH=%TOOLS_DIR%\node_modules;%NODE_PATH%"
node -e "try{require.resolve('playwright')}catch(e){require.resolve('playwright-core')}" >nul 2>nul || (
  echo Installing playwright-core for the lookup tool, once...
  call npm install --silent --no-audit --no-fund --prefix "%TOOLS_DIR%" playwright-core || (echo Could not install playwright-core.& pause & exit /b 1)
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (echo Microsoft Edge was not found.& pause & exit /b 1)

call :cdp && goto run
echo Opening Edge (profile %PROFILE_DIR%) on DCIM and webpe. Sign in to both there once; the profile remembers it.
start "" "%EDGE%" --user-data-dir="%PROFILE_DIR%" --remote-debugging-port=%PORT% --remote-debugging-address=127.0.0.1 --no-first-run "%DCIM_URL%" "%WEBPE_PAGE%"
for /l %%i in (1,1,60) do (
  call :cdp && goto run
  ping -n 2 127.0.0.1 >nul
)
echo Edge did not open remote debugging on 127.0.0.1:%PORT%. Close every Edge window that uses %PROFILE_DIR% and run this again.
pause
exit /b 1

:run
rem The lookup keeps running through sign-outs; if it stops for another reason it starts again after 10 seconds.
node "%HERE%sync.cjs" --watch
echo The lookup stopped; starting it again in 10 seconds (close this window to stop it).
ping -n 11 127.0.0.1 >nul
goto run

:cdp
node -e "fetch('http://127.0.0.1:%PORT%/json/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >nul 2>nul
exit /b %errorlevel%

:install
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\webpe auto lookup.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath=$env:SELF; $s.WorkingDirectory=$env:HERE; $s.WindowStyle=7; $s.Description='webpe auto lookup for DCIM'; $s.Save()" || (echo Could not add the Startup shortcut.& exit /b 1)
echo Added "%LINK%": the lookup starts at every sign-in to Windows.
exit /b 0
