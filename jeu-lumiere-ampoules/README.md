# Jeu de lumière - Ampoules Tapo

## Étape 1 : connecter le compte Tapo (à faire toi-même)

1. Copie `config.example.json` en `config.json` (même dossier).
2. Ouvre `config.json` et remplace `tapo_email` / `tapo_password` par l'email et le
   mot de passe de ton compte Tapo (celui de l'appli Tapo sur ton téléphone).
   Ce fichier reste local et n'est jamais envoyé nulle part (il est aussi exclu de git).
3. Vérifie que ce PC est connecté au **même réseau Wi-Fi** que les ampoules.

## Étape 2 : découvrir les ampoules

Dans un terminal, dans ce dossier :

```bash
python discover.py
```

Le script liste les ampoules trouvées (nom, modèle, IP, support couleur).
Copie la liste proposée dans le champ `"bulbs"` de `config.json`, par exemple :

```json
"bulbs": [
  { "name": "Ampoule 1", "ip": "192.168.1.50" },
  { "name": "Ampoule 2", "ip": "192.168.1.51" }
]
```

## Étape 3 : lancer le contrôleur et la page web

Installe les dépendances puis lance le serveur :

```bash
pip install -r requirements.txt
python app.py
```

Ouvre ensuite http://localhost:5050 (ou `http://<ip-de-ce-pc>:5050` depuis un téléphone
sur le même Wi-Fi). Clique sur "Se connecter aux ampoules", choisis un effet
(statique, arc-en-ciel, strobe, ou réactif au son via le micro de ce PC), règle
la couleur/vitesse, puis "Démarrer" / "Arrêter".
