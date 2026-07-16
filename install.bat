@echo off
echo ============================================================
echo  Lab Manager - First-time install
echo ============================================================
echo.

:: Refresh PATH so Python and Node added by winget are visible
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%ProgramFiles%\nodejs;%APPDATA%\npm"

echo [1/4] Installing Python dependencies...
cd /d "%~dp0backend"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt
if errorlevel 1 ( echo ERROR: pip install failed & pause & exit /b 1 )
echo Done.

echo.
echo [2/4] Installing Node dependencies...
cd /d "%~dp0frontend"
call npm install --silent
if errorlevel 1 ( echo ERROR: npm install failed & pause & exit /b 1 )
echo Done.

echo.
echo [3/4] Building frontend...
call npm run build
if errorlevel 1 ( echo ERROR: frontend build failed & pause & exit /b 1 )
echo Done.

echo.
echo [4/4] Seeding lab devices into database...
cd /d "%~dp0backend"
python seed.py
if errorlevel 1 ( echo ERROR: seed failed & pause & exit /b 1 )

echo.
echo ============================================================
echo  Install complete! Run start.bat to launch Lab Manager.
echo ============================================================
pause
