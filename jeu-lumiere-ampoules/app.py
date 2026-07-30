"""Serveur web pour piloter le jeu de lumière des ampoules Tapo.

Usage:
    python app.py
Puis ouvre http://localhost:5050 (ou http://<ip-de-ce-pc>:5050 depuis un autre appareil).
"""
import asyncio
import socket
import threading

from flask import Flask, jsonify, render_template, request

from controller import EFFECTS, LightShow

app = Flask(__name__)
show = LightShow()


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
def connect():
    try:
        n = run_async(show.connect())
        return jsonify(ok=True, bulbs=n, bulb_names=[d.alias for d in show.bulbs])
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


@app.route("/api/day_mode", methods=["POST"])
def day_mode():
    try:
        run_async(show.restore_day_mode())
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


@app.route("/api/start", methods=["POST"])
def start():
    data = request.get_json(force=True) or {}
    effect = data.get("effect", "statique")
    params = data.get("params", {})
    try:
        run_async(show.start(effect, params))
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


@app.route("/api/stop", methods=["POST"])
def stop():
    try:
        run_async(show.stop())
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


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
