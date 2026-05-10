@echo off
echo [1/3] Stopping any existing Node.js processes...
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >NUL

echo [2/3] Clearing old cache...
if exist ".next" rmdir /s /q ".next"

echo [3/3] Starting Next.js dev server on 0.0.0.0:3000...
start http://localhost:3000
npx next dev -H 0.0.0.0
