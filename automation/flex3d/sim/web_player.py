"""Interactive Flex view for the local chat site.

Serves the MuJoCo machine on 127.0.0.1 for the web page. The page shows two
images that it can request at any time t (the main view and the follow
close-up, each with its own orbit and zoom), plus the step list and the
analysis JSON. A protocol is loaded with POST /flex3d/load; the key is a hash
of the analysis, so the same script is loaded once. The serial dilution
example is always resident. This does not talk to a robot.

    PYTHONPATH=. /usr/bin/python3 -m sim.web_player

Routes (all under /flex3d):
    POST /load                        analysis JSON body -> info (key, steps, camera, limits)
    GET  /<key>/info                  info for a loaded protocol
    GET  /<key>/analysis.json         the analysis the protocol was built from
    GET  /<key>/view.json             meshes and keyframes for the browser
    GET  /<key>/main.jpg?t&az&el&dist
    GET  /<key>/close.jpg?t&az&el&dist
    GET  /health
    POST /close                       matching launcher instance -> graceful exit
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import mujoco

from sim.flex_protocol import ProtocolError, load_analysis, plan as make_plan, scene_spec
from sim.flex_scene import EXPORT, ROOT, deck_camera_pose, load_deck, load_model, write_model
from sim.play_protocol import CLOSE_DEFAULT_ORBIT, CLOSE_WEB_H, CLOSE_WEB_W, FRAME_H, MAIN_W, Renderer, Scene, analyze
from sim.view_scene import write_view

HOST = "127.0.0.1"
PORT = 8791
FPS = 30
JPEG_QUALITY = 88
MAX_MODELS = 4
MAX_BODY = 32 * 1024 * 1024
VIEWER = ROOT / "viewer.html"
WEB = ROOT / "web"
STATIC = {
    "/viewer.js": WEB / "viewer.js",
    "/vendor/three.module.js": WEB / "vendor" / "three.module.js",
    "/vendor/OrbitControls.js": WEB / "vendor" / "OrbitControls.js",
}
EXAMPLE_KEY = "example"
# Set by the Node launcher so ownership checks can distinguish this process
# from a different viewer that reuses the same port later.
INSTANCE_ID = os.environ.get("FLEX3D_INSTANCE_ID", "").strip()[:128]
# Elevation stays below zero, so no camera drops under the deck.
EL_RANGE = (-89.0, -1.0)
MAIN_DIST = (0.35, 4.0)
CLOSE_DIST = (0.08, 1.2)
ROUTE = re.compile(r"^/flex3d/(?P<key>[a-z0-9]{1,32})/(?P<what>info|analysis\.json|view\.json|main\.jpg|close\.jpg)$")
ASSET = re.compile(r"^/flex3d/(?P<key>[a-z0-9]{1,32})/assets/(?P<file>[A-Za-z0-9_.-]+\.png)$")


class Model:
    """One protocol: its MuJoCo model, the renderers, and the step list the page shows."""

    def __init__(self, key: str, analysis: Path, folder: Path) -> None:
        deck = load_deck()
        run = load_analysis(analysis, deck)
        plan = make_plan(run)
        xml = write_model(deck, scene_spec(plan), folder)
        model = load_model(xml)
        data = mujoco.MjData(model)
        self.key = key
        self.title = run.title
        self.duration = float(plan.duration)
        self.analysis_path = analysis
        self.folder = folder
        posed = Scene(plan, model, data)
        self.view_path = write_view(plan, posed, folder)
        self.plan, self.scene = plan, posed
        self._renderer = None
        # Browser meshes need no server-side OpenGL context. JPEG routes opt in.
        pos, look = deck_camera_pose(deck)
        offset = [b - a for a, b in zip(pos, look)]
        distance = math.sqrt(sum(v * v for v in offset))
        self.main_default = {
            "azimuth": math.degrees(math.atan2(offset[1], offset[0])),
            "elevation": math.degrees(math.asin(offset[2] / distance)),
            "distance": distance,
            "lookat": list(look),
        }
        self.pipettes = [{"mount": p.mount, "name": p.name, "tool": p.tool} for p in run.pipettes.values()]
        self.steps = [
            {
                "index": i,
                "cmd": step.cmd,
                "commandId": run.commands[step.cmd].get("id"),
                "kind": step.kind,
                "text": step.text,
                "detail": step.detail,
                "t0": round(step.t0, 3),
                "t1": round(step.t1, 3),
                "slots": list(step.slots),
                "tool": step.tool,
            }
            for i, step in enumerate(plan.steps)
        ]

    def info(self) -> dict:
        return {
            "key": self.key,
            "title": self.title,
            "duration": round(self.duration, 3),
            "pipettes": self.pipettes,
            "camera": {
                "main": {
                    "azimuth": self.main_default["azimuth"],
                    "elevation": self.main_default["elevation"],
                    "distance": self.main_default["distance"],
                    "lookat": self.main_default["lookat"],
                },
                "close": {"azimuth": CLOSE_DEFAULT_ORBIT[0], "elevation": CLOSE_DEFAULT_ORBIT[1], "distance": CLOSE_DEFAULT_ORBIT[2]},
            },
            "limits": {
                "elevation": list(EL_RANGE),
                "mainDistance": list(MAIN_DIST),
                "closeDistance": list(CLOSE_DIST),
            },
            "frame": {
                "main_width": MAIN_W,
                "main_height": FRAME_H,
                "close_width": CLOSE_WEB_W,
                "close_height": CLOSE_WEB_H,
                "fps": FPS,
            },
            "steps": self.steps,
        }

    @property
    def renderer(self):
        if self._renderer is None:
            self._renderer = Renderer(self.plan, self.scene)
            self._renderer.build_track(FPS)
        return self._renderer

    def main_jpeg(self, t: float, azimuth: float, elevation: float, distance: float) -> bytes:
        t = min(max(t, 0.0), self.duration)
        orbit = (azimuth, _clamp(elevation, EL_RANGE), _clamp(distance, MAIN_DIST))
        return _jpeg(self.renderer.web_main(t, orbit))

    def close_jpeg(self, t: float, azimuth: float, elevation: float, distance: float) -> bytes:
        t = min(max(t, 0.0), self.duration)
        orbit = (azimuth, _clamp(elevation, EL_RANGE), _clamp(distance, CLOSE_DIST))
        return _jpeg(self.renderer.web_close(t, orbit))

    def close(self) -> None:
        if self._renderer is not None:
            for renderer in (self._renderer.main, self._renderer.close, self._renderer.close_web):
                renderer.close()


class Registry:
    """Loaded protocols, most recent last. The example stays; live scripts are evicted oldest first."""

    def __init__(self) -> None:
        self._models: OrderedDict[str, Model] = OrderedDict()

    def get(self, key: str) -> Model | None:
        model = self._models.get(key)
        if model is not None:
            self._models.move_to_end(key)
        return model

    def put(self, model: Model) -> None:
        self._models[model.key] = model
        self._models.move_to_end(model.key)
        while len(self._models) > MAX_MODELS:
            victim = next(k for k in self._models if k != EXAMPLE_KEY)
            self._models.pop(victim).close()

    def keys(self) -> list[str]:
        return list(self._models)


def _clamp(value: float, bounds: tuple[float, float]) -> float:
    return min(max(value, bounds[0]), bounds[1])


def _jpeg(image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def _num(qs: dict[str, list[str]], key: str, default: float) -> float:
    raw = qs.get(key, [None])[0]
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if not math.isfinite(value):
        return default
    return value


def load_live(registry: Registry, body: bytes) -> Model:
    """Build a protocol from an analysis JSON body. Raises ValueError for bad input, ProtocolError for unsupported scripts."""

    try:
        raw = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"body is not JSON: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("commands"), list):
        raise ValueError("analysis commands must be a list")
    key = hashlib.sha256(body).hexdigest()[:16]
    existing = registry.get(key)
    if existing is not None:
        return existing
    folder = EXPORT / "live" / key
    folder.mkdir(parents=True, exist_ok=True)
    analysis = folder / f"{key}.analysis.json"
    analysis.write_bytes(body)
    model = Model(key, analysis, folder)
    registry.put(model)
    return model


def make_handler(registry: Registry) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.0 closes each request. HTTP/1.1 keep-alive on this
        # single thread would pin the MuJoCo context and stall a second client.
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:
            try:
                self._get()
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_POST(self) -> None:
            try:
                self._post()
            except (BrokenPipeError, ConnectionResetError):
                return

        def _get(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path in ("/", "/viewer.html"):
                if not VIEWER.is_file():
                    self._json({"error": "viewer_missing"}, code=404)
                    return
                # viewer.js cannot boot without ?key=. Rather than serve a page
                # that is guaranteed to show "no key", send the browser to the
                # model that is actually loaded (most recently used last).
                if not parse_qs(parsed.query).get("key"):
                    registered = registry.keys()
                    if registered:
                        self._redirect(f"/viewer.html?key={registered[-1]}")
                        return
                self._bytes(VIEWER.read_bytes(), "text/html; charset=utf-8")
                return
            static = STATIC.get(parsed.path)
            if static is not None:
                if not static.is_file():
                    self._json({"error": "missing", "path": parsed.path}, code=404)
                    return
                self._bytes(static.read_bytes(), "text/javascript; charset=utf-8")
                return
            if parsed.path == "/flex3d/health":
                self._json(
                    {
                        "ok": True,
                        "service": "labscriptai-flex3d",
                        "pid": os.getpid(),
                        "instance": INSTANCE_ID or None,
                        "models": registry.keys(),
                    }
                )
                return
            asset = ASSET.match(parsed.path)
            if asset is not None:
                model = registry.get(asset["key"])
                root = (model.folder / "flex_assets").resolve() if model is not None else None
                path = (root / asset["file"]).resolve() if root is not None else None
                if path is None or not path.is_file() or root not in path.parents:
                    self._json({"error": "not_found"}, code=404)
                    return
                self._bytes(path.read_bytes(), "image/png")
                return
            match = ROUTE.match(parsed.path)
            if match is None:
                self._json({"error": "not_found"}, code=404)
                return
            model = registry.get(match["key"])
            if model is None:
                self._json({"error": "unknown_model"}, code=404)
                return
            what = match["what"]
            if what == "info":
                self._json(model.info())
            elif what == "analysis.json":
                self._bytes(model.analysis_path.read_bytes(), "application/json; charset=utf-8")
            elif what == "view.json":
                self._bytes(model.view_path.read_bytes(), "application/json; charset=utf-8")
            else:
                qs = parse_qs(parsed.query)
                main = what == "main.jpg"
                default = model.main_default if main else None
                az = _num(qs, "az", default["azimuth"] if main else CLOSE_DEFAULT_ORBIT[0])
                el = _num(qs, "el", default["elevation"] if main else CLOSE_DEFAULT_ORBIT[1])
                dist = _num(qs, "dist", default["distance"] if main else CLOSE_DEFAULT_ORBIT[2])
                t = _num(qs, "t", 0.0)
                jpeg = model.main_jpeg(t, az, el, dist) if main else model.close_jpeg(t, az, el, dist)
                self._bytes(jpeg, "image/jpeg")

        def _post(self) -> None:
            if urlparse(self.path).path == "/flex3d/close":
                if not INSTANCE_ID or self.headers.get("X-Flex3d-Instance") != INSTANCE_ID:
                    self._json({"error": "wrong_instance"}, code=409)
                    return
                self._json({"ok": True, "closing": True, "instance": INSTANCE_ID})
                self.server.stop_requested = True
                return
            if INSTANCE_ID and self.headers.get("X-Flex3d-Instance") != INSTANCE_ID:
                self._json({"error": "wrong_instance", "message": "This request does not belong to the running viewer."}, code=409)
                return
            if urlparse(self.path).path != "/flex3d/load":
                self._json({"error": "not_found"}, code=404)
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self._json({"error": "bad_length", "message": "Content-Length must be a number"}, code=400)
                return
            if length <= 0 or length > MAX_BODY:
                self._json({"error": "bad_length", "message": f"body must be 1 to {MAX_BODY} bytes"}, code=400)
                return
            body = self.rfile.read(length)
            try:
                model = load_live(registry, body)
            except ValueError as exc:
                self._json({"error": "bad_analysis", "message": str(exc)}, code=400)
                return
            except ProtocolError as exc:
                self._json({"error": "unsupported", "message": str(exc)}, code=422)
                return
            except Exception as exc:  # the page shows the message; the server keeps running
                self._json({"error": "load_failed", "message": f"{type(exc).__name__}: {exc}"}, code=500)
                return
            self._json(model.info())

        def _json(self, body: dict, code: int = 200) -> None:
            raw = json.dumps(body).encode()
            self._bytes(raw, "application/json; charset=utf-8", code)

        def _redirect(self, location: str) -> None:
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _bytes(self, raw: bytes, content_type: str, code: int = 200) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt: str, *args) -> None:
            if len(args) >= 2 and args[1] != "200":
                super().log_message(fmt, *args)

    return Handler


def resolve_analysis(protocol: Path) -> Path:
    protocol = protocol.resolve()
    if not protocol.exists():
        raise SystemExit(f"protocol not found: {protocol}")
    if protocol.suffix == ".py":
        return analyze(protocol)
    return protocol


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve interactive Flex protocol views on 127.0.0.1")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--protocol", type=Path, default=None, help="optional analysis or protocol to preload")
    args = parser.parse_args()
    if args.host != HOST:
        raise SystemExit("refusing to bind anything except 127.0.0.1")
    registry = Registry()
    label = "idle"
    # The page needs ?key=; print the URL the operator should actually open.
    viewer_url = f"http://{args.host}:{args.port}/viewer.html"
    if args.protocol is not None:
        analysis = resolve_analysis(args.protocol)
        example = Model(EXAMPLE_KEY, analysis, EXPORT / "protocols" / analysis.name.replace(".analysis.json", "").replace(".json", ""))
        registry.put(example)
        label = f"{example.title}  {example.duration:.1f}s"
        viewer_url = f"{viewer_url}?key={EXAMPLE_KEY}"
    # One thread: the MuJoCo GL contexts have to stay on the thread that created them.
    server = HTTPServer((args.host, args.port), make_handler(registry))
    print(
        f"flex3d {viewer_url}  {label}",
        flush=True,
    )
    server.timeout = 0.5
    try:
        while not getattr(server, "stop_requested", False):
            server.handle_request()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
