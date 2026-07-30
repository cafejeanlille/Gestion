# Vérifie si le serveur du jeu de lumière répond, le relance sinon.
$dossier = "C:\Users\cafej\OneDrive\Desktop\Cafe jean\jeu-lumiere-ampoules"
$portOuvert = Test-NetConnection -ComputerName 127.0.0.1 -Port 5050 -InformationLevel Quiet -WarningAction SilentlyContinue

if (-not $portOuvert) {
    Set-Location $dossier
    Start-Process -FilePath "python" -ArgumentList "app.py" -WindowStyle Minimized
}
