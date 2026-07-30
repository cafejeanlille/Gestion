"""Contrôleur des ampoules Tapo : connexion et effets lumineux."""
import asyncio
import json
from pathlib import Path

from kasa import Discover, Credentials, Module

CONFIG_PATH = Path(__file__).parent / "config.json"

EFFECTS = ["statique", "arc_en_ciel", "strobe", "son"]

# Mode journée : teinte "or" de la DA du café (#C1912F), plus tamisée pour le bar
# et la salle que pour le reste.
DAY_MODE_HUE = 25
DAY_MODE_SATURATION = 85
DAY_MODE_BRIGHTNESS_TAMISE = 50
DAY_MODE_BRIGHTNESS_NORMALE = 100
DAY_MODE_PREFIXES_TAMISES = ("bar", "salle")


class LightShow:
    def __init__(self):
        self.bulbs = []
        self.effect = None
        self.params = {}
        self._task = None
        self._stop_event = None

    async def connect(self):
        if not CONFIG_PATH.exists():
            raise RuntimeError("config.json introuvable (copie config.example.json et remplis-le).")
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not config.get("bulbs"):
            raise RuntimeError("Aucune ampoule dans config.json (lance discover.py puis remplis 'bulbs').")
        creds = Credentials(config["tapo_email"], config["tapo_password"])
        bulbs = []
        for b in config["bulbs"]:
            dev = await Discover.discover_single(b["ip"], credentials=creds)
            await dev.update()
            bulbs.append(dev)
        self.bulbs = bulbs
        return len(self.bulbs)

    async def restore_day_mode(self):
        if not self.bulbs:
            raise RuntimeError("Pas d'ampoule connectée, appelle connect() d'abord.")
        await self.stop()
        await self._turn_all(True)

        async def _set_one(dev):
            if Module.Light not in dev.modules:
                return
            nom = (dev.alias or "").strip().lower()
            tamisee = nom.startswith(DAY_MODE_PREFIXES_TAMISES)
            brightness = DAY_MODE_BRIGHTNESS_TAMISE if tamisee else DAY_MODE_BRIGHTNESS_NORMALE
            await dev.modules[Module.Light].set_hsv(DAY_MODE_HUE, DAY_MODE_SATURATION, brightness)

        await asyncio.gather(*(_set_one(dev) for dev in self.bulbs), return_exceptions=True)

    async def _set_all(self, hue, sat, val):
        await asyncio.gather(
            *(
                dev.modules[Module.Light].set_hsv(int(hue) % 360, int(sat), int(val))
                for dev in self.bulbs
                if Module.Light in dev.modules
            ),
            return_exceptions=True,
        )

    async def _turn_all(self, on: bool):
        await asyncio.gather(
            *((dev.turn_on() if on else dev.turn_off()) for dev in self.bulbs),
            return_exceptions=True,
        )

    async def start(self, effect: str, params: dict):
        if effect not in EFFECTS:
            raise ValueError(f"Effet inconnu: {effect}")
        if not self.bulbs:
            raise RuntimeError("Pas d'ampoule connectée, appelle connect() d'abord.")
        await self.stop()
        self.effect = effect
        self.params = params or {}
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._stop_event.set()
            await self._task
            self._task = None
            self.effect = None

    async def _run(self):
        try:
            if self.effect == "statique":
                await self._run_statique()
            elif self.effect == "arc_en_ciel":
                await self._run_arc_en_ciel()
            elif self.effect == "strobe":
                await self._run_strobe()
            elif self.effect == "son":
                await self._run_son()
        except asyncio.CancelledError:
            pass

    async def _wait(self, seconds):
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _run_statique(self):
        h, s, v = self.params.get("color", [280, 100, 100])
        await self._turn_all(True)
        await self._set_all(h, s, v)

    async def _run_arc_en_ciel(self):
        await self._turn_all(True)
        hue = 0
        speed = self.params.get("speed", 6.0)
        brightness = self.params.get("brightness", 100)
        while not self._stop_event.is_set():
            await self._set_all(hue, 100, brightness)
            hue = (hue + speed) % 360
            await self._wait(0.3)

    async def _run_strobe(self):
        speed = max(0.5, self.params.get("speed", 5.0))
        delay = max(0.05, 1.0 / (2 * speed))
        h, s, v = self.params.get("color", [0, 0, 100])
        await self._set_all(h, s, v)
        on = False
        while not self._stop_event.is_set():
            on = not on
            await self._turn_all(on)
            await self._wait(delay)
        await self._turn_all(True)

    async def _run_son(self):
        import numpy as np
        import sounddevice as sd

        await self._turn_all(True)
        hue = self.params.get("hue", 280)
        volume = 0.0

        def audio_callback(indata, frames, time_info, status):
            nonlocal volume
            volume = float(np.sqrt(np.mean(indata**2)))

        with sd.InputStream(channels=1, callback=audio_callback, samplerate=44100):
            while not self._stop_event.is_set():
                brightness = min(100, max(8, int(volume * 900)))
                await self._set_all(hue, 100, brightness)
                await self._wait(0.15)

    def status(self):
        return {
            "connected": len(self.bulbs),
            "bulb_names": [dev.alias for dev in self.bulbs],
            "effect": self.effect,
            "params": self.params,
        }
