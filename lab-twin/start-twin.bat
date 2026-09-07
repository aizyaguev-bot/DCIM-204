@echo off
:: Lab Manager - Digital Twin : serve the folder locally and open the browser.
:: Needed because browsers block fetch() of lab-data.json from file:// .
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts"
cd /d "%~dp0"
echo Starting Digital Twin at http://localhost:8090  (Ctrl+C to stop)
start "" "http://localhost:8090/index.html"
python -m http.server 8090
