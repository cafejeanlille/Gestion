"""
Découvre les ampoules Tapo présentes sur le réseau local et affiche
leur nom, modèle, adresse IP et capacités (couleur ou non).

Usage:
    python discover.py

Lit l'email/mot de passe Tapo depuis config.json (copie de config.example.json).
N'affiche jamais le mot de passe.
"""
import asyncio
import json
import sys
from pathlib import Path

from kasa import Discover, Credentials, Module

CONFIG_PATH = Path(__file__).parent / "config.json"


def load_credentials() -> Credentials:
    if not CONFIG_PATH.exists():
        print(
            "Fichier config.json introuvable.\n"
            "Copie config.example.json vers config.json et renseigne ton "
            "email et mot de passe du compte Tapo (celui utilisé dans "
            "l'appli Tapo)."
        )
        sys.exit(1)
    data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    email = data.get("tapo_email", "")
    password = data.get("tapo_password", "")
    if not email or not password or "exemple.com" in email:
        print("Renseigne un vrai email et mot de passe Tapo dans config.json avant de continuer.")
        sys.exit(1)
    return Credentials(email, password)


async def main():
    creds = load_credentials()
    print("Recherche des appareils Tapo sur le réseau local (10s)...")
    devices = await Discover.discover(credentials=creds, discovery_timeout=10)

    if not devices:
        print(
            "Aucun appareil trouvé. Vérifie que:\n"
            "  - les ampoules sont allumées et connectées au Wi-Fi\n"
            "  - ce PC est sur le même réseau Wi-Fi que les ampoules\n"
            "  - le pare-feu Windows autorise Python sur les réseaux privés"
        )
        return

    print(f"\n{len(devices)} appareil(s) trouvé(s):\n")
    results = []
    for ip, dev in devices.items():
        try:
            await dev.update()
        except Exception as e:
            print(f"  - IP: {ip} -> ignoré (erreur: {e})\n")
            continue
        has_color = Module.Color in dev.modules
        print(f"  - Nom: {dev.alias!r}")
        print(f"    Modèle: {dev.model}")
        print(f"    IP: {ip}")
        print(f"    Couleur (RGB) supportée: {'oui' if has_color else 'non'}")
        print()
        results.append({"name": dev.alias, "ip": ip, "model": dev.model, "color": has_color})

    print("Copie ces entrées dans la liste \"bulbs\" de config.json, par exemple:")
    print(json.dumps([{"name": r["name"], "ip": r["ip"]} for r in results], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
