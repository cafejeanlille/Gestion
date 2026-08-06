"""Serveur web pour piloter le jeu de lumière des ampoules Tapo.

Usage:
    python app.py
Puis ouvre http://localhost:5050 (ou http://<ip-de-ce-pc>:5050 depuis un autre appareil).
"""
import asyncio
import socket
import threading
from functools import wraps

from flask import Flask, jsonify, render_template, request

from controller import EFFECTS, LightShow

app = Flask(__name__)
show = LightShow()


def api_route(fn):
    """Exécute la route et convertit toute exception en réponse JSON d'erreur."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            payload = fn(*args, **kwargs) or {}
            return jsonify(ok=True, **payload)
        except Exception as e:
            return jsonify(ok=False, error=str(e)), 400
    return wrapper


@app.after_request
def add_cors_headers(response):
    # Permet d'appeler ce serveur depuis l'appli principale Café Jean (autre origine).
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

_loop = asyncio.new_event_loop()


def _run_loop():
    asyncio.set_event_loop(_loop)
    _loop.run_forever()


threading.Thread(target=_run_loop, daemon=True).start()


def run_async(coro, timeout=15):
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout=timeout)


@app.route("/")
def index():
    return render_template("index.html", effects=EFFECTS)


@app.route("/api/status")
def status():
    return jsonify(ok=True, **show.status())


@app.route("/api/connect", methods=["POST"])
@api_route
def connect():
    n = run_async(show.connect(), timeout=30)
    return dict(bulbs=n, **show.status())


@app.route("/api/toggle_bulb", methods=["POST"])
@api_route
def toggle_bulb():
    data = request.get_json(force=True) or {}
    ip = data.get("ip")
    enabled = bool(data.get("enabled"))
    run_async(show.toggle_bulb(ip, enabled))
    return show.status()


@app.route("/api/toggle_secteur", methods=["POST"])
@api_route
def toggle_secteur():
    data = request.get_json(force=True) or {}
    secteur = data.get("secteur")
    enabled = bool(data.get("enabled"))
    run_async(show.toggle_secteur(secteur, enabled))
    return show.status()


@app.route("/api/set_secteur_brightness", methods=["POST"])
@api_route
def set_secteur_brightness():
    data = request.get_json(force=True) or {}
    secteur = data.get("secteur")
    brightness = data.get("brightness")
    run_async(show.set_secteur_brightness(secteur, brightness))


@app.route("/api/day_mode", methods=["POST"])
@api_route
def day_mode():
    run_async(show.restore_day_mode())


@app.route("/api/closing_mode", methods=["POST"])
@api_route
def closing_mode():
    run_async(show.restore_closing_mode())


@app.route("/api/start", methods=["POST"])
@api_route
def start():
    data = request.get_json(force=True) or {}
    effect = data.get("effect", "statique")
    params = data.get("params", {})
    run_async(show.start(effect, params))


@app.route("/api/stop", methods=["POST"])
@api_route
def stop():
    run_async(show.stop())


def _local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    ip = _local_ip()
    print("=" * 50)
    print(f"  Depuis un telephone/tablette sur le meme Wi-Fi, ouvre :")
    print(f"  http://{ip}:5050")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5050, debug=False)
