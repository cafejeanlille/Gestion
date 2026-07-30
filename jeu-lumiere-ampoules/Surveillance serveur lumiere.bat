@echo off
cd /d "%~dp0"
:boucle
powershell -NoProfile -Command "(Test-NetConnection -ComputerName 127.0.0.1 -Port 5050 -InformationLevel Quiet -WarningAction SilentlyContinue)" | findstr /i "True" >nul
if errorlevel 1 (
    start "Jeu de lumiere - serveur" /min python app.py
)
timeout /t 30 /nobreak >nul
goto boucle
