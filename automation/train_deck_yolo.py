#!/usr/bin/env python3
"""
Train a deck labware detector from Phase 3 YOLO export.

Usage (from repo root):
  python automation/export_yolo_dataset.py
  python automation/train_deck_yolo.py
  python automation/train_deck_yolo.py --epochs 100 --name deck_phase3

Weights are written to vision/runs/detect/<name>/weights/best.pt and copied to
vision/models/weights/deck_v2_best.pt for vision_check auto-pick.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
DATA_YAML = REPO_ROOT / "vision" / "data" / "deck_phase3" / "data.yaml"
RUNS_DIR = REPO_ROOT / "vision" / "runs" / "detect"
WEIGHTS_DIR = REPO_ROOT / "vision" / "models" / "weights"
DEFAULT_BEST_LINK = WEIGHTS_DIR / "deck_v2_best.pt"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", type=Path, default=DATA_YAML, help="Ultralytics data.yaml")
    p.add_argument("--model", default="yolo11n.pt", help="Base checkpoint (auto-downloaded)")
    p.add_argument("--epochs", type=int, default=80)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--name", default="deck_phase3", help="Run name under vision/runs/detect/")
    p.add_argument("--device", default="", help="Ultralytics device, e.g. 0 or cpu")
    args = p.parse_args()

    if not args.data.is_file():
        raise SystemExit(f"Missing dataset yaml: {args.data}\nRun: python automation/export_yolo_dataset.py")

    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("Install ultralytics first: pip install ultralytics") from exc

    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Training on {args.data.resolve()}")
    print(f"Run name: {args.name}  epochs={args.epochs}  model={args.model}")

    model = YOLO(args.model)
    results = model.train(
        data=str(args.data.resolve()),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        project=str(RUNS_DIR),
        name=args.name,
        exist_ok=True,
        device=args.device or None,
    )

    best_src = RUNS_DIR / args.name / "weights" / "best.pt"
    if not best_src.is_file():
        raise SystemExit(f"Training finished but missing weights: {best_src}")

    shutil.copy2(best_src, DEFAULT_BEST_LINK)
    print(f"\nBest weights: {best_src.resolve()}")
    print(f"Copied to:    {DEFAULT_BEST_LINK.resolve()}")
    print("\nRe-run Phase 2 baseline:")
    print("  .venv\\Scripts\\python.exe automation\\compare_phase1_vision.py")
    print("Or set explicitly:")
    print(f"  $env:OPENTRONS_DECK_YOLO_WEIGHTS=\"{DEFAULT_BEST_LINK.resolve()}\"")

    return results


if __name__ == "__main__":
    main()
