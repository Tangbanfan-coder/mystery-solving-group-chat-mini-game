@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$k=[Environment]::GetEnvironmentVariable('role-playing-key','User'); if(-not $k){Write-Host 'missing env var: role-playing-key' -ForegroundColor Yellow; pause; exit 1}; $env:ROLE_PLAYING_KEY=$k; $env:PORT='5178'; Write-Host ''; Write-Host '  open http://127.0.0.1:5178' -ForegroundColor Cyan; Write-Host ''; node server.js"
pause
