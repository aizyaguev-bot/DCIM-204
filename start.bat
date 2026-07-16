@echo off
:: Refresh PATH
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%ProgramFiles%\nodejs;%APPDATA%\npm"

echo Starting Lab Manager...
echo   Backend:  http://localhost:8000
echo   Open this URL in your browser after a few seconds.
echo.
echo Press Ctrl+C to stop.
echo.

cd /d "%~dp0backend"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
