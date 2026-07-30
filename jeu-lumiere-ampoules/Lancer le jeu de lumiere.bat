@echo off
cd /d "%~dp0"
start "Jeu de lumiere - serveur" python app.py
echo.
echo Serveur lance (dans l'autre fenetre qui vient de s'ouvrir).
echo Ouvre l'appli Cafe Jean puis l'onglet "Lumiere" pour piloter les ampoules.
echo Laisse la fenetre "Jeu de lumiere - serveur" ouverte tant que tu l'utilises.
timeout /t 6 >nul
