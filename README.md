# API locale de démonstration

API Python gratuite et locale pour tester la vérification d'e-mails sans HIBP.

## Lancer

```bash
python main.py --web
```

Interface : `http://localhost:8000`

## API

```text
POST /api/check-email
```

Exemple avec `curl` :

```bash
curl -X POST -d "email=demo@example.com" http://localhost:8000/api/check-email
```

## Données de démonstration

- `demo@example.com` → 2 fuites fictives
- `test@example.com` → 1 fuite fictive
- toute autre adresse → aucune fuite fictive

Les données sont entièrement synthétiques et ne proviennent d'aucune fuite réelle.
Aucune clé API n'est nécessaire.
