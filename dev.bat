@echo off
:: Run backend + Vite dev server in two windows (for active development only)
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%ProgramFiles%\nodejs;%APPDATA%\npm"

start "Lab Manager - Backend" cmd /k "cd /d %~dp0backend && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
start "Lab Manager - Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo Both servers started.
echo   Backend API:  http://localhost:8000
echo   Frontend UI:  http://localhost:5173
timeout /t 2 >nul
start "" "http://localhost:5173"
