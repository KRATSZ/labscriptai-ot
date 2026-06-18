#!/usr/bin/env python3
"""Run vision_check on automation/photo/test/*.jpg and write JSON + annotated outputs."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
VISION_SCRIPT = REPO_ROOT / "servers" / "opentrons-mcp" / "scripts" / "vision_check.py"
CALIBRATION = SCRIPT_DIR / "photo" / "deck_calibration.json"
POLICY_PATH = SCRIPT_DIR / "deck_layout_policy.json"
TEST_DIR = SCRIPT_DIR / "photo" / "test"
OUT_DIR = TEST_DIR / "vision"
ANN_DIR = OUT_DIR / "annotated"


def parse_vision_stdout(stdout: str) -> dict:
    text = stdout.strip()
    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if candidate.startswith("{"):
            return json.loads(candidate)
    start = text.rfind("{")
    if start >= 0:
        return json.loads(text[start:])
    raise ValueError("no JSON in vision_check stdout")


def resolve_weights() -> Path:
    candidates = [
        REPO_ROOT / "vision" / "models" / "weights" / "deck_v2_best.pt",
        REPO_ROOT / "vision" / "runs" / "detect" / "deck_phase3" / "weights" / "best.pt",
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise SystemExit("Missing trained deck weights. Run automation/train_deck_yolo.py first.")


def main() -> None:
    cal = json.loads(CALIBRATION.read_text(encoding="utf-8"))
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    detect_slots: list[str] = list(policy.get("detection_slots") or [])
    fixed = sorted((policy.get("fixed_slots") or {}).keys())
    corners = cal.get("optional_deck_corners_norm")
    weights = resolve_weights()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ANN_DIR.mkdir(parents=True, exist_ok=True)

    images = sorted(TEST_DIR.glob("test_*.jpg"))
    if not images:
        raise SystemExit(f"No test images in {TEST_DIR}")

    print(f"Weights: {weights}")
    print(f"Images:  {len(images)}")
    print(f"Detect:  {', '.join(detect_slots)}")
    print(f"Fixed:   {', '.join(fixed)}\n")

    report_items: list[dict] = []
    for img in images:
        payload = {
            "mode": "deck",
            "image_path": str(img.resolve()),
            "conf_threshold": 0.2,
            "deck_corners_norm": corners,
            "weights": str(weights.resolve()),
            "annotated_output_dir": str(ANN_DIR.resolve()),
        }
        proc = subprocess.run(
            [sys.executable, str(VISION_SCRIPT)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if proc.returncode != 0:
            raise SystemExit(
                f"vision_check failed for {img.name}:\n{proc.stderr.strip() or proc.stdout.strip()}"
            )
        vision = parse_vision_stdout(proc.stdout)
        slots = vision.get("slot_observations") or {}
        summary = vision.get("summary") or ""

        print(f"=== {img.name} ===")
        for slot in detect_slots:
            obs = slots.get(slot) or {}
            state = str(obs.get("state") or "unknown")
            label = str(obs.get("label") or "-")
            conf = obs.get("confidence")
            conf_s = f"{conf:.2f}" if isinstance(conf, (int, float)) else "-"
            print(f"  {slot}: {state:10} {label:14} conf={conf_s}")
        print(f"  summary: {summary}")
        print(f"  annotated: {vision.get('annotated_image_path')}\n")

        (OUT_DIR / f"{img.stem}.vision.json").write_text(
            json.dumps(vision, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        report_items.append(
            {
                "file": img.name,
                "summary": summary,
                "detection_slots": {slot: slots.get(slot) for slot in detect_slots},
                "annotated_image_path": vision.get("annotated_image_path"),
            }
        )

    report_path = OUT_DIR / "vision_report.json"
    report_path.write_text(
        json.dumps(
            {
                "weights": str(weights.resolve()),
                "detection_slots": detect_slots,
                "fixed_slots": fixed,
                "images": report_items,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Report: {report_path.resolve()}")
    print(f"Annotated: {ANN_DIR.resolve()}")


if __name__ == "__main__":
    main()
