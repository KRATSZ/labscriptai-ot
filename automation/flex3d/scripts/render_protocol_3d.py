#!/usr/bin/env python3
"""One-shot Flex 3D checks. Always prints a single JSON object.

Reads an opentrons analyze JSON (or a .py, which is analyzed first).
OT-2 is refused before MuJoCo starts. A missing mujoco install prints
a degraded error and exits 0 so the caller can keep going.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FLEX_ROBOTS = {"OT-3 Standard", "Flex"}


def emit(payload: dict) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(0)


def robot_type(raw: dict) -> str | None:
    if not isinstance(raw, dict):
        return None
    value = raw.get("robotType")
    if value:
        return str(value)
    metadata = raw.get("metadata")
    if isinstance(metadata, dict) and metadata.get("robotType"):
        return str(metadata["robotType"])
    config = raw.get("config")
    if isinstance(config, dict) and config.get("robotType"):
        return str(config["robotType"])
    return None


def command_index(message: str, plan=None) -> int | None:
    """0-based, same numbering as LogicPass step_index."""
    match = re.search(r"command (\d+)", message)
    if match:
        return int(match.group(1)) - 1
    match = re.search(r"t=([0-9.]+) s", message)
    if not match or plan is None:
        return None
    t = float(match.group(1))
    for step in plan.steps:
        if step.t0 - 1e-3 <= t <= step.t1 + 1e-3:
            return step.cmd
    return None


def check_item(name: str, status: str, detail: str, plan=None) -> dict:
    return {
        "name": name,
        "status": status,
        "command_index": command_index(detail, plan) if status == "fail" else None,
        "detail": detail,
    }


def load_raw(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Flex 3D checks for one analysis")
    parser.add_argument("source", type=Path, help="analysis JSON or protocol .py")
    parser.add_argument("--video", action="store_true", help="also write an MP4")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    source = args.source.resolve()
    if not source.is_file():
        emit({"ok": False, "error": "missing_source", "message": f"missing file: {source}", "checks": [], "files": []})

    if source.suffix == ".py":
        python = os.environ.get("OPENTRONS_PYTHON", sys.executable)
        produced = source.with_suffix(".analysis.json")
        done = subprocess.run(
            [python, "-m", "opentrons.cli", "analyze", "--json-output", str(produced), str(source)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if done.returncode != 0 or not produced.is_file():
            emit({
                "ok": False,
                "error": "analyze_failed",
                "message": (done.stderr or done.stdout or "opentrons analyze failed")[-4000:],
                "checks": [],
                "files": [],
            })
        source = produced

    try:
        raw = load_raw(source)
    except (OSError, json.JSONDecodeError) as exc:
        emit({"ok": False, "error": "bad_analysis", "message": str(exc), "checks": [], "files": []})

    kind = robot_type(raw)
    if kind and kind not in FLEX_ROBOTS:
        emit({
            "ok": False,
            "supported": False,
            "error": "ot2_not_supported",
            "robot_type": kind,
            "message": f"the 3D preview only supports Flex; this protocol is {kind}",
            "checks": [],
            "files": [],
        })

    os.environ.setdefault("FLEX3D_EXPORT", str(args.out or (ROOT / "runs")))
    try:
        import mujoco
        from sim.flex_protocol import ProtocolError, load_analysis, plan as make_plan, scene_spec
        from sim.flex_scene import EXPORT, load_deck, load_model, write_model
        from sim.play_protocol import Renderer, Scene, check_clearance, check_liquid, check_targets, render_video
    except ImportError as exc:
        emit({
            "ok": False,
            "degraded": True,
            "error": "mujoco_missing",
            "robot_type": kind,
            "message": f"mujoco (or numpy/Pillow) is not installed, so the 3D preview and its four checks are unavailable: {exc}",
            "checks": [],
            "files": [],
        })

    out = Path(os.environ["FLEX3D_EXPORT"]) / source.stem.replace(".analysis", "")
    out.mkdir(parents=True, exist_ok=True)
    try:
        deck = load_deck()
        run = load_analysis(source, deck)
        plan = make_plan(run)
        xml = write_model(deck, scene_spec(plan), out)
        model = load_model(xml)
        data = mujoco.MjData(model)
        scene = Scene(plan, model, data)
    except ProtocolError as exc:
        message = str(exc)
        unsupported = "not a Flex" in message or "robotType" in message
        emit({
            "ok": False,
            "supported": False if unsupported else None,
            "error": "ot2_not_supported" if unsupported else "protocol_error",
            "robot_type": kind,
            "message": message,
            "checks": [],
            "files": [],
        })
    except Exception as exc:  # scene build failed; report it, do not dump a traceback as the only output
        emit({
            "ok": False,
            "error": "scene_failed",
            "robot_type": kind,
            "message": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(limit=8),
            "checks": [],
            "files": [],
        })

    checks: list[dict] = []
    try:
        _hits, worst_json, worst_sim = check_targets(plan, scene)
        checks.append(check_item("geometry", "pass", f"JSON vs labware definition worst {worst_json:.3f} mm"))
        checks.append(check_item("targets", "pass", f"MuJoCo tip vs JSON worst {worst_sim:.3f} mm"))
    except RuntimeError as exc:
        message = str(exc)
        if "JSON position" in message:
            checks.append(check_item("geometry", "fail", message, plan))
            checks.append(check_item("targets", "skipped", "geometry failed before target points were checked"))
        else:
            checks.append(check_item("geometry", "pass", "JSON matched the labware definition before the target check failed"))
            checks.append(check_item("targets", "fail", message, plan))

    try:
        clearance, tightest, samples = check_clearance(plan, scene)
        checks.append(check_item(
            "clearance",
            "pass",
            f"{samples} samples; tightest enclosure gap {clearance * 1000:.1f} mm at {tightest}",
        ))
    except RuntimeError as exc:
        checks.append(check_item("clearance", "fail", str(exc), plan))

    try:
        liquid = check_liquid(plan)
        short = next((item for item in plan.warnings if "asked for" in item), None)
        if short:
            checks.append(check_item("liquid", "fail", short, plan))
        else:
            wells = sum(len(item) for item in liquid.values())
            checks.append(check_item("liquid", "pass", f"no negative volumes; {wells} wells in the final state"))
    except RuntimeError as exc:
        checks.append(check_item("liquid", "fail", str(exc), plan))

    files: list[dict] = []
    trace = out / f"{source.stem}_checks.json"
    trace.write_text(json.dumps({"robot_type": kind, "checks": checks}, indent=2), encoding="utf-8")
    files.append({"kind": "checks", "path": str(trace)})

    if args.video:
        video = out / f"{source.stem}.mp4"
        renderer = Renderer(plan, scene)
        render_video(plan, renderer, video, 30)
        files.append({"kind": "mp4", "path": str(video)})

    failed = [item["name"] for item in checks if item["status"] == "fail"]
    emit({
        "ok": True,
        "supported": True,
        "advisory": True,
        "robot_type": kind or "OT-3 Standard",
        "analysis_path": str(source),
        "export_dir": str(EXPORT),
        "failed_checks": failed,
        "checks": checks,
        "files": files,
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        emit({
            "ok": False,
            "error": "render_failed",
            "message": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(limit=12),
            "checks": [],
            "files": [],
        })
