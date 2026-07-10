@echo off
rem VectorBrush launcher — a chromeless Edge app window over a local
rem server (proper origin for IndexedDB persistence; also lets an iPad
rem on the same LAN open http://<this-pc-ip>:8321/ for device testing).
cd /d "%~dp0"

rem start the server only if it isn't already running on the port
netstat -an | findstr ":8321 " | findstr LISTENING >nul
if errorlevel 1 (
  start "VectorBrush server (close me to stop)" /min ^
    python -m http.server 8321 --directory app
  rem give it a beat to bind
  ping -n 2 127.0.0.1 >nul
)

start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --app=http://localhost:8321/index.html --window-size=1280,860
