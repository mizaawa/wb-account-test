@echo off
cd /d "%~dp0"
if not defined ADDR set "ADDR=127.0.0.1:8080"
echo WB Pulse: http://127.0.0.1:8080
powershell.exe -NoProfile -Command "Start-Process 'http://127.0.0.1:8080'"
wb-pulse.exe
