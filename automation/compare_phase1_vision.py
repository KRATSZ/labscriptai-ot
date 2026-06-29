#!/usr/bin/env python3
"""
Phase 2: run vision_check on Phase 1 ground-truth images and compare slot labels.

Requires: pip install ultralytics opencv-python-headless pillow

Usage (from repo root):
  python automation/compare_phase1_vision.py
  python automation/compare_phase1_vision.py --conf 0.2
  python automation/compare_phase1_vision.py --out automation/photo/phase2
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from deck_geometry import detection_slot_names, fixed_slot_names, load_deck_layout_policy

SCRIPT_DIR = Path(__file__).resolve().parent
PHOTO_DIR = SCRIPT_DIR / "photo"
MANIFEST = PHOTO_DIR / "phase1_manifest.json"
CALIBRATION = PHOTO_DIR / "deck_calibration.json"
LABELS_DIR = PHOTO_DIR / "labels"
POLICY_PATH = SCRIPT_DIR / "deck_layout_policy.json"
VISION_SCRIPT = SCRIPT_DIR.parent / "servers" / "opentrons-mcp" / "scripts" / "vision_check.py"

SLOT_NAMES = [
    "A1",
    "A2",
    "A3",
    "B1",
    "B2",
    "B3",
    "C1",
    "C2",
    "C3",
    "D1",
    "D2",
    "D3",
]


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def python_exe() -> str:
    return sys.executable


def parse_vision_stdout(stdout: str) -> dict:
    text = stdout.strip()
    if not text:
        raise json.JSONDecodeError("empty stdout", text, 0)
    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if candidate.startswith("{"):
            return json.loads(candidate)
    start = text.rfind("{")
    if start >= 0:
        return json.loads(text[start:])
    raise json.JSONDecodeError("no JSON object in stdout", text, 0)


def resolve_weights() -> str | None:
    repo_root = SCRIPT_DIR.parent
    env_deck = os.environ.get("OPENTRONS_DECK_YOLO_WEIGHTS")
    if env_deck and Path(env_deck).is_file():
        return str(Path(env_deck).resolve())
    deck_candidates = [
        repo_root / "vision" / "models" / "weights" / "deck_v2_best.pt",
        repo_root / "vision" / "runs" / "detect" / "deck_phase3" / "weights" / "best.pt",
    ]
    for path in deck_candidates:
        if path.is_file():
            return str(path.resolve())
    env = os.environ.get("OPENTRONS_YOLOE_WEIGHTS")
    if env and Path(env).is_file():
        return str(Path(env).resolve())
    yoloe_candidates = [
        repo_root / "yoloe-26s-seg.pt",
        repo_root / "vision" / "models" / "weights" / "yoloe-26s-seg.pt",
    ]
    for path in yoloe_candidates:
        if path.is_file():
            return str(path.resolve())
    return None


def run_vision_check(
    image_path: Path,
    *,
    conf: float,
    corners: list[list[float]] | None,
    expected_layout: dict[str, str],
    annotated_dir: Path,
) -> dict:
    payload = {
        "mode": "deck",
        "image_path": str(image_path.resolve()),
        "conf_threshold": conf,
        "load_labels_sidecar": True,
        "expected_layout": expected_layout,
        "annotated_output_dir": str(annotated_dir.resolve()),
    }
    if corners:
        payload["deck_corners_norm"] = corners
    weights = resolve_weights()
    if weights:
        payload["weights"] = weights

    proc = subprocess.run(
        [python_exe(), str(VISION_SCRIPT)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"vision_check failed for {image_path.name} (exit {proc.returncode})\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    try:
        return parse_vision_stdout(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"vision_check returned invalid JSON for {image_path.name}: {exc}\n"
            f"{proc.stdout[-800:]}\n{proc.stderr[-800:]}"
        ) from exc


def vision_slot_label(obs: dict) -> str:
    state = str(obs.get("state") or "unknown").lower()
    label = obs.get("label")
    if state == "empty":
        return "empty"
    if state == "occupied" and label:
        return str(label).lower()
    if state == "uncertain":
        return "uncertain"
    return "unknown"


def compare_slots(expected: dict[str, str], slot_observations: dict[str, dict], eval_slots: list[str]) -> dict:
    per_slot: dict[str, dict] = {}
    occupancy_hits = 0
    label_hits = 0
    total = 0

    for slot in eval_slots:
        exp = str(expected.get(slot, "unknown")).lower()
        obs = slot_observations.get(slot) or {}
        got = vision_slot_label(obs)
        exp_empty = exp == "empty"
        got_empty = got == "empty"
        occupancy_ok = exp_empty == got_empty or (not exp_empty and got not in {"empty", "unknown", "uncertain"})
        if exp_empty and got_empty:
            occupancy_ok = True
        elif not exp_empty and got == exp:
            occupancy_ok = True
        elif not exp_empty and got in {"empty", "uncertain", "unknown"}:
            occupancy_ok = False
        elif exp_empty and got not in {"empty"}:
            occupancy_ok = False

        label_ok = got == exp
        if exp == "unknown" or got == "uncertain":
            label_ok = False

        if exp != "unknown":
            total += 1
            if occupancy_ok:
                occupancy_hits += 1
            if label_ok:
                label_hits += 1

        per_slot[slot] = {
            "expected": exp,
            "vision_state": obs.get("state"),
            "vision_label": obs.get("label"),
            "vision_effective": got,
            "occupancy_match": occupancy_ok,
            "label_match": label_ok,
            "reasons": obs.get("reasons") or [],
        }

    return {
        "per_slot": per_slot,
        "occupancy_accuracy": round(occupancy_hits / total, 4) if total else 0.0,
        "label_accuracy": round(label_hits / total, 4) if total else 0.0,
        "slots_compared": total,
        "occupancy_hits": occupancy_hits,
        "label_hits": label_hits,
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--conf", type=float, default=0.2, help="vision_check confidence threshold")
    p.add_argument("--out", type=Path, default=PHOTO_DIR / "phase2", help="Report and annotated output dir")
    args = p.parse_args()

    if not MANIFEST.is_file():
        raise SystemExit(f"Missing {MANIFEST}")
    if not VISION_SCRIPT.is_file():
        raise SystemExit(f"Missing {VISION_SCRIPT}")
    if not CALIBRATION.is_file():
        raise SystemExit(f"Missing {CALIBRATION}")

    manifest = load_json(MANIFEST)
    calibration = load_json(CALIBRATION)
    policy = load_deck_layout_policy(POLICY_PATH)
    eval_slots = detection_slot_names(policy)
    fixed = fixed_slot_names(policy)
    corners = calibration.get("optional_deck_corners_norm")

    out_dir: Path = args.out
    annotated_dir = out_dir / "annotated"
    out_dir.mkdir(parents=True, exist_ok=True)
    annotated_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    total_occ = 0
    total_label = 0
    total_slots = 0

    print(f"Phase 2 vision baseline — conf={args.conf}")
    print(f"Evaluating detection slots only: {', '.join(eval_slots)}")
    print(f"Fixed slots excluded: {', '.join(sorted(fixed))}")
    print(f"Output: {out_dir.resolve()}\n")

    for entry in manifest.get("images") or []:
        filename = str(entry.get("file") or "")
        image_path = PHOTO_DIR / filename
        label_path = LABELS_DIR / f"{image_path.stem}.labels.json"
        if not image_path.is_file():
            raise SystemExit(f"Missing image: {image_path}")
        if not label_path.is_file():
            raise SystemExit(f"Missing labels: {label_path}")

        labels = load_json(label_path)
        expected = {slot: str(labels["slots"].get(slot, "unknown")).lower() for slot in SLOT_NAMES}
        unknown_count = sum(1 for v in expected.values() if v == "unknown")
        if unknown_count:
            print(f"WARN {filename}: {unknown_count} slot(s) still unknown in ground truth")

        print(f"Running vision_check: {filename} ...", flush=True)
        vision = run_vision_check(
            image_path,
            conf=args.conf,
            corners=corners,
            expected_layout=expected,
            annotated_dir=annotated_dir,
        )
        slot_obs = vision.get("slot_observations") or {}
        cmp = compare_slots(expected, slot_obs, eval_slots)

        total_occ += cmp["occupancy_hits"]
        total_label += cmp["label_hits"]
        total_slots += cmp["slots_compared"]

        mismatches = [
            {"slot": slot, **detail}
            for slot, detail in cmp["per_slot"].items()
            if not detail["label_match"] and expected[slot] != "unknown"
        ]

        item = {
            "image": filename,
            "scenario": entry.get("scenario"),
            "occupancy_accuracy": cmp["occupancy_accuracy"],
            "label_accuracy": cmp["label_accuracy"],
            "mismatches": mismatches,
            "vision_summary": vision.get("summary"),
            "needs_human_review": vision.get("needs_human_review"),
            "slot_mapping_method": (vision.get("slot_mapping") or {}).get("method"),
            "annotated_image_path": vision.get("annotated_image_path"),
            "per_slot": cmp["per_slot"],
        }
        results.append(item)

        (out_dir / f"{image_path.stem}.vision.json").write_text(
            json.dumps(vision, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        print(
            f"  occupancy {cmp['occupancy_accuracy']:.0%} | "
            f"label {cmp['label_accuracy']:.0%} | "
            f"mismatches {len(mismatches)}"
        )

    summary = {
        "phase": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "detection_slots": eval_slots,
        "fixed_slots": sorted(fixed),
        "layout_policy": str(POLICY_PATH.name),
        "conf_threshold": args.conf,
        "images_evaluated": len(results),
        "aggregate_occupancy_accuracy": round(total_occ / total_slots, 4) if total_slots else 0.0,
        "aggregate_label_accuracy": round(total_label / total_slots, 4) if total_slots else 0.0,
        "total_slots_compared": total_slots,
        "results": results,
    }

    report_path = out_dir / "phase2_report.json"
    report_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print("\n=== Phase 2 summary ===")
    print(f"Aggregate occupancy accuracy: {summary['aggregate_occupancy_accuracy']:.1%}")
    print(f"Aggregate label accuracy:       {summary['aggregate_label_accuracy']:.1%}")
    print(f"Report: {report_path.resolve()}")
    print(f"Annotated images: {annotated_dir.resolve()}")


if __name__ == "__main__":
    main()
