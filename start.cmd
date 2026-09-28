@echo off
rem MiaoDraw - AI image creation client (Electron + Bailian API)
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo First run: installing dependencies...
  call npm install
)
if not exist "out\main\index.js" (
  echo Building...
  call npm run build
)
start "" "%~dp0node_modules\electron\dist\electron.exe" .
