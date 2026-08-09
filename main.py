#!/usr/bin/env python3
"""
checker.py - Vérificateur local de robustesse et de fuite de mots de passe.

Ce script :
  1. Calcule un score de robustesse LOCAL (longueur, variété de caractères,
     motifs communs, séquences, répétitions) - rien ne quitte votre machine.
  2. Vérifie si le mot de passe apparaît dans des fuites connues via l'API
     "Pwned Passwords" de Have I Been Pwned, en utilisant le modèle
     k-anonymity : seuls les 5 premiers caractères du hash SHA-1 du mot de
     passe sont envoyés au service. Le mot de passe et son hash complet ne
     quittent JAMAIS votre machine.
     Référence : https://haveibeenpwned.com/API/v3#PwnedPasswords

Aucun mot de passe n'est jamais journalisé, écrit sur disque ou affiché en
clair dans les rapports (ils sont masqués).

Usage :
  Vérifier un seul mot de passe (saisie masquée, interactive) :
      python checker.py

  Vérifier une liste de mots de passe depuis un fichier local
  (un mot de passe par ligne, ex. export de gestionnaire de mots de passe) :
      python checker.py --file mes_mdp.txt --report rapport.md

  Le fichier peut aussi contenir des lignes au format "email:motdepasse"
  (un identifiant par ligne). L'email n'est utilisé que pour étiqueter le
  rapport localement : il n'est jamais envoyé sur le réseau, seul le hash
  partiel du mot de passe l'est (voir check_pwned). L'email est lui aussi
  masqué dans l'affichage et le rapport.

  Le fichier d'entrée n'est jamais modifié ni recopié ailleurs.
"""

from __future__ import annotations

import argparse
import getpass
import html
import threading

import hashlib
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/{prefix}"
USER_AGENT = "local-password-audit-tool/1.0 (+privacy-preserving k-anonymity check)"
REQUEST_TIMEOUT = 10  # secondes
DELAY_BETWEEN_REQUESTS = 1.6  # secondes, pour rester courtois envers l'API publique

COMMON_PASSWORDS = {
    "password", "123456", "123456789", "qwerty", "azerty", "admin",
    "letmein", "welcome", "monkey", "dragon", "football", "iloveyou",
    "password1", "123123", "abc123", "111111", "123321", "sunshine",
    "princess", "trustno1", "000000", "1234567", "12345678", "1234567890",
}


# --------------------------------------------------------------------------
# Analyse de robustesse locale (aucun réseau)
# --------------------------------------------------------------------------

@dataclass
class StrengthResult:
    score: int  # 0 (très faible) à 4 (très robuste)
    issues: list[str] = field(default_factory=list)


def analyze_strength(password: str) -> StrengthResult:
    issues: list[str] = []
    length = len(password)

    if length < 8:
        issues.append("Moins de 8 caractères")
    elif length < 12:
        issues.append("Moins de 12 caractères (recommandé: 12+)")

    classes = {
        "minuscules": bool(re.search(r"[a-z]", password)),
        "majuscules": bool(re.search(r"[A-Z]", password)),
        "chiffres": bool(re.search(r"\d", password)),
        "symboles": bool(re.search(r"[^\w\s]", password)),
    }
    missing = [name for name, present in classes.items() if not present]
    if missing:
        issues.append("Manque: " + ", ".join(missing))

    if password.lower() in COMMON_PASSWORDS:
        issues.append("Mot de passe extrêmement courant")

    if re.search(r"(.)\1{2,}", password):
        issues.append("Caractère répété 3 fois ou plus de suite")

    sequences = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "azertyuiop"]
    lowered = password.lower()
    for seq in sequences:
        for i in range(len(seq) - 3):
            chunk = seq[i:i + 4]
            if chunk in lowered or chunk[::-1] in lowered:
                issues.append(f"Séquence prévisible détectée ({chunk})")
                break

    # Score simple 0-4 basé sur longueur + diversité, pénalisé par les issues.
    variety = sum(classes.values())
    base_score = 0
    if length >= 8:
        base_score += 1
    if length >= 12:
        base_score += 1
    if length >= 16:
        base_score += 1
    base_score += 1 if variety >= 3 else 0
    score = max(0, min(4, base_score - (1 if password.lower() in COMMON_PASSWORDS else 0)))

    return StrengthResult(score=score, issues=issues)


# --------------------------------------------------------------------------
# Vérification de compromission d'un compte par e-mail
# --------------------------------------------------------------------------

@dataclass
class AccountBreachResult:
    checked: bool
    breaches: list[dict] = field(default_factory=list)
    error: str | None = None


def check_account_breaches(email: str) -> AccountBreachResult:
    """Recherche locale de démonstration : toutes les données sont fictives."""
    demo_database = {
        "demo@example.com": [
            {
                "Name": "DemoShop",
                "Domain": "demo.example",
                "BreachDate": "2025-03-15",
                "AddedDate": "2025-03-20",
                "DataClasses": ["Emails", "Usernames", "IP addresses", "Phone numbers", "Passwords"],
            },
            {
                "Name": "DemoForum",
                "Domain": "forum.demo.example",
                "BreachDate": "2024-08-10",
                "AddedDate": "2024-08-15",
                "DataClasses": ["Emails", "Usernames", "IP addresses"],
            },
        ],
        "test@example.com": [
            {
                "Name": "TestMarket",
                "Domain": "test.example",
                "BreachDate": "2023-11-05",
                "AddedDate": "2023-11-12",
                "DataClasses": ["Emails", "Usernames", "Passwords"],
            }
        ],
    }
    return AccountBreachResult(
        checked=True,
        breaches=demo_database.get(email.strip().lower(), [])
    )


def format_breach_details(breach: dict) -> str:
    """Formate les métadonnées d'une fuite sans afficher de données volées."""
    name = html.escape(str(breach.get("Name") or "Service inconnu"))
    domain = html.escape(str(breach.get("Domain") or "Non précisé"))
    date = html.escape(str(breach.get("BreachDate") or "Date inconnue"))
    added = html.escape(str(breach.get("AddedDate") or "Non précisée"))
    classes = breach.get("DataClasses") or []
    data_classes = ", ".join(html.escape(str(item)) for item in classes)

    return (
        f"<article class='breach-item'>"
        f"<h3>{name}</h3>"
        f"<p><strong>Domaine :</strong> {domain}</p>"
        f"<p><strong>Date de la fuite :</strong> {date}</p>"
        f"<p><strong>Ajoutée à la base :</strong> {added}</p>"
        f"<p><strong>Données signalées comme exposées :</strong> "
        f"{data_classes or 'Non précisé'}</p>"
        f"</article>"
    )


# --------------------------------------------------------------------------
# Vérification de fuite via Have I Been Pwned (k-anonymity)
# --------------------------------------------------------------------------

@dataclass
class BreachResult:
    checked: bool
    pwned: bool = False
    count: int = 0
    error: str | None = None


def check_pwned(password: str) -> BreachResult:
    sha1 = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()
    prefix, suffix = sha1[:5], sha1[5:]

    req = urllib.request.Request(
        HIBP_RANGE_URL.format(prefix=prefix),
        headers={"User-Agent": USER_AGENT, "Add-Padding": "true"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.URLError as exc:
        return BreachResult(checked=False, error=str(exc))

    for line in body.splitlines():
        parts = line.strip().split(":")
        if len(parts) != 2:
            continue
        line_suffix, count_str = parts
        if line_suffix == suffix:
            try:
                count = int(count_str)
            except ValueError:
                count = 0
            # "Add-Padding" insère de fausses entrées avec count=0 pour brouiller
            # l'analyse de trafic ; count=0 signifie donc "non trouvé".
            if count > 0:
                return BreachResult(checked=True, pwned=True, count=count)
            return BreachResult(checked=True, pwned=False)

    return BreachResult(checked=True, pwned=False)


# --------------------------------------------------------------------------
# Rapport
# --------------------------------------------------------------------------


def mask(password: str) -> str:
    if len(password) <= 2:
        return "*" * len(password)
    return password[:2] + "*" * (len(password) - 2)


def mask_email(email: str) -> str:
    """Masque un email pour l'affichage local, ex. jo***@gmail.com.
    Ne quitte jamais la machine — utilisé uniquement pour étiqueter le rapport.
    """
    if "@" not in email:
        return mask(email)
    local, _, domain = email.partition("@")
    if len(local) <= 2:
        masked_local = "*" * len(local)
    else:
        masked_local = local[:2] + "*" * (len(local) - 2)
    return f"{masked_local}@{domain}"


def strength_label(score: int) -> str:
    return ["Très faible", "Faible", "Moyen", "Bon", "Excellent"][score]


def print_result(label: str, password: str, strength: StrengthResult, breach: BreachResult) -> str:
    """Construit un rapport clair sans jamais révéler le mot de passe."""
    lines = [
        "## Résultat de l'audit",
        "",
        f"**Compte :** {label}",
        f"**Mot de passe testé :** `{mask(password)}`",
        "",
        "### Robustesse",
        f"**{strength_label(strength.score)}** — {strength.score}/4",
    ]

    if strength.issues:
        lines.append("")
        lines.append("Points à améliorer :")
        lines.extend(f"- ⚠ {issue}" for issue in strength.issues)
    else:
        lines.extend(["", "✓ Aucun problème local détecté."])

    lines.extend(["", "### Vérification des fuites"])

    if not breach.checked:
        lines.extend([
            "⚠ **Vérification impossible**",
            f"Le service de vérification n'a pas pu être contacté : {breach.error}",
        ])
    elif breach.pwned:
        lines.extend([
            "🚨 **MOT DE PASSE COMPROMIS**",
            f"Ce mot de passe apparaît dans des fuites connues **{breach.count:,} fois**.",
            "",
            "➡ **Action recommandée : changez immédiatement ce mot de passe** "
            "sur tous les services où il est utilisé.",
        ])
    else:
        lines.extend([
            "✓ **Aucun compromis connu détecté**",
            "Ce mot de passe n'a pas été trouvé dans les fuites connues consultées.",
        ])

    lines.extend([
        "",
        "---",
        "🔒 Le mot de passe complet n'est jamais affiché, enregistré ou envoyé.",
    ])

    report = "\n".join(lines)
    print(report)
    return report



# --------------------------------------------------------------------------
# Mode démo — données 100 % fictives
# --------------------------------------------------------------------------

DEMO_EMAIL = "demo@example.com"

DEMO_BREACH = {
    "Name": "DemoShop",
    "Domain": "demo.example",
    "BreachDate": "2025-03-15",
    "AddedDate": "2025-03-20",
    "DataClasses": [
        "Emails",
        "Usernames",
        "IP addresses",
        "Phone numbers",
        "Passwords",
    ],
}

DEMO_VALUES = {
    "email": DEMO_EMAIL,
    "username": "JeanDemo",
    "phone": "000-000-0000",
    "password": "DemoPassword123!",
    "ip": "192.0.2.10",
}


def demo_result_html() -> str:
    """Retourne uniquement des données synthétiques destinées à la démonstration."""
    return f"""
<div class="card result-card">
<h2>Résultat de la vérification</h2>
<p class="account">E-mail : <strong>{html.escape(DEMO_EMAIL)}</strong></p>

<div class="status danger">
  <div class="status-title">🚨 COMPROMIS — MODE DÉMO</div>
  <div>Cette compromission est entièrement fictive et sert uniquement à tester l'interface.</div>
</div>

<div class="section">
  <h3>Fuite simulée</h3>
  <div class="breach-item">
    <h3>DemoShop</h3>
    <p><strong>Domaine :</strong> demo.example</p>
    <p><strong>Date de la fuite :</strong> 15 mars 2025</p>
    <p><strong>Données exposées :</strong> e-mail, nom d'utilisateur,
    téléphone, adresse IP, mot de passe</p>
  </div>
</div>

<div class="section">
  <h3>Exemple de données fictives</h3>
  <div class="demo-data">
    <p><strong>E-mail :</strong> {html.escape(DEMO_VALUES["email"])}</p>
    <p><strong>Nom d'utilisateur :</strong> {html.escape(DEMO_VALUES["username"])}</p>
    <p><strong>Téléphone :</strong> {html.escape(DEMO_VALUES["phone"])}</p>
    <p><strong>Adresse IP :</strong> {html.escape(DEMO_VALUES["ip"])}</p>
    <p><strong>Mot de passe :</strong> {html.escape(DEMO_VALUES["password"])}</p>
  </div>
</div>

<div class="recommendation">
<strong>MODE DÉMO :</strong> toutes les valeurs ci-dessus sont inventées.
Elles ne proviennent d'aucune fuite réelle.
</div>

<div class="privacy-note">
🔒 Le mode réel ne doit jamais afficher les secrets provenant d'une fuite.
</div>
</div>"""


# --------------------------------------------------------------------------
# Interface web locale
# --------------------------------------------------------------------------

RESULTS_FILE = Path("resultats.txt")
# 127.0.0.1 par défaut : le formulaire transmet des mots de passe en clair
# (HTTP, pas TLS) et ne doit donc pas être exposé au réseau local. Ne changez
# HOST que si vous savez ce que vous faites (ex. usage derrière un reverse
# proxy TLS de confiance).
WEB_HOST = __import__("os").environ.get("HOST", "127.0.0.1")
WEB_PORT = int(__import__("os").environ.get("PORT", "8000"))

# Protège l'écriture (création + append) de RESULTS_FILE contre les accès
# concurrents : ThreadingHTTPServer traite chaque requête sur son propre
# thread, donc plusieurs "/check" simultanés pourraient sinon se marcher
# dessus lors de la création du fichier (check-then-act).
_RESULTS_LOCK = threading.Lock()


def save_web_result(label: str, strength: StrengthResult, breach: BreachResult) -> None:
    """Enregistre uniquement le résultat masqué, jamais le mot de passe."""
    if not breach.checked:
        breach_text = f"Erreur lors de la vérification de fuite : {breach.error}"
    elif breach.pwned:
        breach_text = f"TROUVÉ dans des fuites connues ({breach.count:,} occurrences)"
    else:
        breach_text = "Non trouvé dans les fuites connues"

    issues = ", ".join(strength.issues) if strength.issues else "Aucun problème local détecté"
    entry = (
        f"[{time.strftime('%Y-%m-%d %H:%M:%S')}]\n"
        f"Compte : {label}\n"
        f"Robustesse : {strength_label(strength.score)} ({strength.score}/4)\n"
        f"Problèmes : {issues}\n"
        f"Fuite : {breach_text}\n"
        f"{'-' * 60}\n"
    )
    with _RESULTS_LOCK:
        if not RESULTS_FILE.exists():
            RESULTS_FILE.write_text(
                "Résultats des vérifications locales\n"
                "===================================\n\n",
                encoding="utf-8",
            )
        with RESULTS_FILE.open("a", encoding="utf-8") as f:
            f.write(entry)


def web_page(message: str = "", result_html: str = "") -> bytes:
    safe_message = html.escape(message)
    return f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vérificateur de mot de passe</title>
<style>
body {{ font-family: sans-serif; max-width: 650px; margin: 50px auto; padding: 0 20px; }}
input, button {{ font-size: 16px; padding: 10px; margin-top: 8px; }}
input {{ width: 100%; box-sizing: border-box; }}
button {{ cursor: pointer; }}
.card {{ margin-top: 25px; padding: 22px; border: 1px solid #d1d5db; border-radius: 14px; background: #fff; box-shadow: 0 4px 14px rgba(0,0,0,.06); }}
.result-card h2 {{ margin-top: 0; }}
.account {{ color: #374151; }}
.status {{ margin: 18px 0; padding: 16px; border-radius: 10px; border-left: 5px solid; }}
.status-title {{ font-size: 19px; font-weight: 700; margin-bottom: 6px; }}
.status.danger {{ color: #991b1b; background: #fef2f2; border-color: #dc2626; }}
.status.warn {{ color: #92400e; background: #fffbeb; border-color: #d97706; }}
.status.ok {{ color: #166534; background: #f0fdf4; border-color: #16a34a; }}
.section {{ margin-top: 20px; }}
.section h3 {{ margin-bottom: 6px; }}
.recommendation {{ margin-top: 18px; padding: 14px; border-radius: 9px; background: #fff7ed; color: #9a3412; }}
.privacy-note {{ margin-top: 20px; padding-top: 14px; border-top: 1px solid #e5e7eb; color: #4b5563; font-size: 14px; }}
.breach-item {{ margin-top: 14px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fafafa; }}
.demo-data {{ padding: 14px; border-radius: 10px; background: #f3f4f6; font-family: monospace; }}
.breach-item h3 {{ margin-top: 0; }}
.secondary {{ margin-left: 8px; }}

.warn {{ color: #9a3412; }}
.ok {{ color: #166534; }}
small {{ color: #555; }}
</style>
</head>
<body>
<h1>Vérificateur de mot de passe</h1>
<p>Vous pouvez vérifier le mot de passe ou rechercher les compromissions publiques associées à l’adresse e-mail. Les secrets volés ne sont jamais affichés.</p>
<form method="post" action="/check" autocomplete="off">
<label for="password">Mot de passe à vérifier</label>
<input id="password" name="password" type="password" required autofocus>
<label for="email">E-mail à vérifier</label>
<input id="email" name="email" type="email" placeholder="exemple@email.com" autocomplete="off" required>

<label for="label">Site / service</label>
<select id="label" name="label">
<option>Instagram</option>
<option>Google</option>
<option>Facebook</option>
<option>Discord</option>
<option>Microsoft</option>
<option>Autre</option>
</select>
<button type="submit">Vérifier le mot de passe</button>
<button type="submit" formaction="/check-email" class="secondary">Vérifier l'e-mail</button>
</form>
{f'<p>{safe_message}</p>' if safe_message else ''}
{result_html}
<p><small>Les résultats sont enregistrés dans <code>{html.escape(str(RESULTS_FILE))}</code>, sans mot de passe en clair.</small></p>
</body>
</html>""".encode("utf-8")


def run_web_server() -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs

    class Handler(BaseHTTPRequestHandler):
        def send_html(self, content: bytes, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            if self.path == "/":
                self.send_html(web_page())
            else:
                self.send_html(web_page("Page introuvable."), 404)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8", errors="replace")
            form = parse_qs(raw)

            if self.path == "/demo":
                self.send_html(web_page(result_html=demo_result_html()))
                return

            if self.path == "/demo-from-email":
                email = form.get("email", [""])[0].strip()
                if not email:
                    self.send_html(web_page("Veuillez saisir une adresse e-mail."), 400)
                    return

                account = check_account_breaches(email)
                masked = mask_email(email)

                if not account.checked:
                    result = f"""
<div class="card result-card">
<h2>Résultat — mode démo alimenté par la vérification Internet</h2>
<p class="account">E-mail : <strong>{html.escape(masked)}</strong></p>
<div class="status warn">
  <div class="status-title">⚠️ Vérification impossible</div>
  <div>{html.escape(account.error or "Erreur inconnue.")}</div>
</div>
</div>"""
                elif account.breaches:
                    details = "".join(format_breach_details(b) for b in account.breaches)
                    result = f"""
<div class="card result-card">
<h2>Résultat complet</h2>
<p class="account">E-mail : <strong>{html.escape(masked)}</strong></p>

<div class="status danger">
  <div class="status-title">🚨 COMPROMIS</div>
  <div><strong>{len(account.breaches)}</strong> fuite(s) retournée(s) par le service.</div>
</div>

<div class="section">
  <h3>Informations récupérées</h3>
  {details}
</div>

<div class="recommendation">
<strong>Important :</strong> cette vue reprend les métadonnées réellement retournées
par le service dans une présentation de démonstration. Elle ne récupère pas et
n'affiche pas les valeurs des données volées.
</div>

<div class="privacy-note">
🔒 Aucun mot de passe, token, cookie ou autre secret provenant d'une fuite n'est affiché.
</div>
</div>"""
                else:
                    result = f"""
<div class="card result-card">
<h2>Résultat complet</h2>
<p class="account">E-mail : <strong>{html.escape(masked)}</strong></p>
<div class="status ok">
  <div class="status-title">✓ Aucun compromis connu</div>
  <div>Aucune fuite connue n'a été retournée pour cette adresse.</div>
</div>
</div>"""

                self.send_html(web_page(result_html=result))
                return

            if self.path == "/api/check-email":
                import json
                email = form.get("email", [""])[0].strip()
                if not email:
                    self.send_response(400)
                    payload = {"error": "Veuillez saisir une adresse e-mail."}
                else:
                    account = check_account_breaches(email)
                    self.send_response(200)
                    payload = {
                        "email": mask_email(email),
                        "checked": account.checked,
                        "compromised": bool(account.breaches),
                        "breach_count": len(account.breaches),
                        "breaches": account.breaches,
                        "demo": True,
                    }
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if self.path == "/check-email":
                email = form.get("email", [""])[0].strip()
                if not email:
                    self.send_html(web_page("Veuillez saisir une adresse e-mail."), 400)
                    return

                account = check_account_breaches(email)
                masked = mask_email(email)

                demo_notice = (
                    "<div class='recommendation'>"
                    "<strong>MODE DÉMO :</strong> cette vérification d'e-mail n'interroge aucun "
                    "service de fuites réel. Seules deux adresses fictives (demo@example.com, "
                    "test@example.com) renvoient un résultat 'compromis' ; toute autre adresse "
                    "s'affichera comme non compromise, que ce soit vrai ou non."
                    "</div>"
                )

                if not account.checked:
                    result = f"""
<div class="card result-card">
<h2>Résultat de la vérification — MODE DÉMO</h2>
<p class="account">E-mail : <strong>{html.escape(masked)}</strong></p>
<div class="status warn">
  <div class="status-title">⚠️ Vérification impossible</div>
  <div>{html.escape(account.error or "Erreur inconnue.")}</div>
</div>
{demo_notice}
<div class="privacy-note">🔒 Aucun mot de passe ou secret volé n'est affiché.</div>
</div>"""
                elif account.breaches:
                    details = "".join(format_breach_details(b) for b in account.breaches)
                    result = f"""
<div class="card result-card">
<h2>Résultat de la vérification — MODE DÉMO</h2>
<p class="account">E-mail : <strong>{html.escape(masked)}</strong></p>
<div class="status danger">
  <div class="status-title">🚨 COMPROMIS (données fictives)</div>
  <div><strong>{len(account.breaches)}</strong> fuite(s) simulée(s) associée(s) à cette adresse de démonstration.</div>
</div>
<div class="section">
  <h3>Détails des compromissions</h3>
  {details}
</div>
{demo_notice}
<div class="privacy-note">
🔒 Seules les métadonnées de compromission sont affichées. Les mots de passe,
tokens et autres secrets volés ne sont jamais affichés.
</div>
</div>"""
                else:
                    result = f"""
<div class="card result-card">
<h2>Résultat de la vérification — MODE DÉMO</h2>
<p class="account">E-mail : <strong>{html.escape(masked)}</strong></p>
<div class="status ok">
  <div class="status-title">✓ Aucun compromis connu (données fictives)</div>
  <div>Aucune fuite simulée n'a été retournée pour cette adresse.</div>
</div>
{demo_notice}
<div class="privacy-note">🔒 Aucun mot de passe ou secret n'est affiché ou enregistré.</div>
</div>"""

                self.send_html(web_page(result_html=result))
                return

            if self.path != "/check":
                self.send_html(web_page("Page introuvable."), 404)
                return

            # Form data has already been parsed above.
            password = form.get("password", [""])[0]
            email = form.get("email", [""])[0].strip()
            label = form.get("label", ["Compte"])[0].strip() or "Compte"

            if not email:
                self.send_html(web_page("Veuillez saisir une adresse e-mail."), 400)
                return

            if not password:
                self.send_html(web_page("Aucun mot de passe saisi."), 400)
                return

            strength = analyze_strength(password)
            breach = check_pwned(password)
            save_web_result(f"{mask_email(email)} ({label})", strength, breach)

            if not breach.checked:
                breach_text = f"Échec ({html.escape(str(breach.error))})"
                css = "warn"
            elif breach.pwned:
                breach_text = f"TROUVÉ dans des fuites connues ({breach.count:,} occurrences)"
                css = "warn"
            else:
                breach_text = "Non trouvé dans les fuites connues"
                css = "ok"

            issues = (
                "".join(f"<li>⚠ {html.escape(issue)}</li>" for issue in strength.issues)
                if strength.issues
                else "<li>Aucun problème local détecté</li>"
            )
            if not breach.checked:
                status_title = "Vérification impossible"
                status_icon = "⚠️"
                status_class = "warn"
                status_detail = f"Le service de vérification n'a pas pu être contacté : {html.escape(str(breach.error))}"
            elif breach.pwned:
                status_title = "Mot de passe compromis"
                status_icon = "🚨"
                status_class = "danger"
                status_detail = (
                    f"Ce mot de passe apparaît dans des fuites connues "
                    f"<strong>{breach.count:,} fois</strong>."
                )
            else:
                status_title = "Aucun compromis connu"
                status_icon = "✓"
                status_class = "ok"
                status_detail = "Ce mot de passe n'a pas été trouvé dans les fuites connues consultées."

            result = f"""
<div class="card result-card">
<h2>Résultat de l'audit</h2>
<p class="account">E-mail : <strong>{html.escape(mask_email(email))}</strong></p>

<div class="status {status_class}">
  <div class="status-title">{status_icon} {status_title}</div>
  <div>{status_detail}</div>
</div>

<div class="section">
  <h3>Robustesse</h3>
  <p><strong>{strength_label(strength.score)}</strong> — {strength.score}/4</p>
  <ul>{issues}</ul>
</div>

{"<div class='recommendation'><strong>Action recommandée :</strong> changez immédiatement ce mot de passe sur tous les services où il est utilisé.</div>" if breach.checked and breach.pwned else ""}

<div class="privacy-note">
  🔒 Le mot de passe complet n'est jamais affiché, enregistré ou envoyé.
</div>
</div>"""
            # Explicitly drop the secret before returning.
            password = None
            self.send_html(web_page(result_html=result))

        def log_message(self, fmt, *args):
            print("[web]", fmt % args)

    server = ThreadingHTTPServer((WEB_HOST, WEB_PORT), Handler)
    print(f"\nInterface web : http://{WEB_HOST}:{WEB_PORT}")
    print(f"Résultats (sans mots de passe) : {RESULTS_FILE.resolve()}")
    print("Arrêt : Ctrl+C")
    server.serve_forever()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def run_single_interactive() -> list[str]:
    password = getpass.getpass("Mot de passe à vérifier (saisie masquée) : ")
    if not password:
        print("Aucun mot de passe saisi.")
        return []
    strength = analyze_strength(password)
    breach = check_pwned(password)
    return [print_result("Mot de passe", password, strength, breach)]


def parse_line(line: str) -> tuple[str | None, str]:
    """Parse une ligne "email:motdepasse" ou "motdepasse" seul.

    Retourne (email_ou_None, motdepasse). Le séparateur est le premier ':'
    rencontré ; tout ce qui suit (y compris d'autres ':') fait partie du
    mot de passe, pour supporter les mots de passe contenant ':'.
    """
    if ":" in line:
        email, _, password = line.partition(":")
        email = email.strip()
        # Garde-fou : si la partie gauche ne ressemble pas à un identifiant
        # (ex. un mot de passe qui contient ':' sans email), on traite toute
        # la ligne comme un mot de passe brut.
        if email and (" " not in email):
            return email, password
    return None, line


def entry_label(i: int, email: str | None) -> str:
    return f"Entrée {i} — {mask_email(email)}" if email else f"Entrée {i}"


def find_duplicate_passwords(entries: list[tuple[str | None, str]]) -> str | None:
    """Détecte les mots de passe réutilisés sur plusieurs entrées.

    Comparaison purement locale (par hash SHA-256 en mémoire, jamais écrit ni
    transmis) — sert uniquement à regrouper les index qui partagent le même
    mot de passe, sans jamais l'afficher en clair.
    """
    groups: dict[str, list[int]] = {}
    for i, (_email, pwd) in enumerate(entries, start=1):
        digest = hashlib.sha256(pwd.encode("utf-8")).hexdigest()
        groups.setdefault(digest, []).append(i)

    duplicate_groups = {h: idxs for h, idxs in groups.items() if len(idxs) > 1}
    if not duplicate_groups:
        return None

    lines = ["## Mots de passe réutilisés", ""]
    lines.append(
        f"⚠ {len(duplicate_groups)} mot(s) de passe réutilisé(s) sur plusieurs entrées. "
        "Un mot de passe partagé entre comptes signifie qu'une seule fuite compromet tous ces comptes."
    )
    lines.append("")
    for idxs in duplicate_groups.values():
        pwd_sample = next(pwd for i, (_e, pwd) in enumerate(entries, start=1) if i == idxs[0])
        labels = [entry_label(i, entries[i - 1][0]) for i in idxs]
        lines.append(f"- `{mask(pwd_sample)}` réutilisé par : " + ", ".join(labels))
    lines.append("")
    text = "\n".join(lines)
    print(text)
    return text


def run_from_file(path: Path) -> list[str]:
    if not path.exists():
        print(f"Fichier introuvable : {path}", file=sys.stderr)
        sys.exit(1)

    raw_lines = [line.rstrip("\n\r") for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not raw_lines:
        print("Fichier vide.")
        return []

    entries = [parse_line(line) for line in raw_lines]

    report_sections = []
    for i, (email, pwd) in enumerate(entries, start=1):
        strength = analyze_strength(pwd)
        breach = check_pwned(pwd)
        report_sections.append(print_result(entry_label(i, email), pwd, strength, breach))
        if i < len(entries):
            time.sleep(DELAY_BETWEEN_REQUESTS)  # courtoisie envers l'API publique

    if len(entries) > 1:
        duplicates_section = find_duplicate_passwords(entries)
        if duplicates_section:
            report_sections.append(duplicates_section)

    return report_sections


def main() -> None:
    # Évite les erreurs d'encodage sur les consoles Windows (cp1252) avec les
    # accents et le symbole ⚠.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Vérificateur local de robustesse / fuite de mots de passe.")
    parser.add_argument("--file", type=str, help="Fichier local avec un mot de passe par ligne.")
    parser.add_argument("--report", type=str, help="Chemin du rapport Markdown à générer.")
    parser.add_argument("--web", action="store_true", help="Lance l’interface web locale.")
    args = parser.parse_args()

    print("== Vérificateur de mots de passe (local, respectueux de la vie privée) ==")
    print("Aucun mot de passe complet n'est jamais transmis sur le réseau.\n")

    if args.web:
        run_web_server()
        return

    if args.file:
        sections = run_from_file(Path(args.file))
    else:
        sections = run_single_interactive()

    if args.report and sections:
        report_path = Path(args.report)
        report_path.write_text(
            "# Rapport d'audit de mots de passe\n\n" + "\n".join(sections),
            encoding="utf-8",
        )
        print(f"Rapport écrit dans : {report_path}")


if __name__ == "__main__":
    main()
