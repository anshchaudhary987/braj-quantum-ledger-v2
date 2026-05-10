@echo off
echo Starting GLM Ledger...
call taskkill /F /IM node.exe 2>NUL
start cmd /k "cd /d %~dp0 && npx next dev -H 0.0.0.0"
timeout /t 5 /nobreak >NUL
start http://localhost:3000
