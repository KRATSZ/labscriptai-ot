#!/usr/bin/env python3
"""
Build or refresh phase3_manifest.json from all deck JPEGs in automation/photo/.

Usage (from repo root):
  python automation/setup_phase3_labels.py --refresh-manifest
  python automation/setup_phase3_labels.py --refresh-manifest --force
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from deck_geometry import detection_class_names, detection_slot_names, load_deck_layout_policy

SCRIPT_DIR = Path(__file__).resolve().parent
PHOTO_DIR = SCRIPT_DIR / "photo"
MANIFEST = PHOTO_DIR / "phase3_manifest.json"
POLICY_PATH = SCRIPT_DIR / "deck_layout_policy.json"

CLASSES = detection_class_names()

SCENARIO_BY_PREFIX = {
    "1_empty_": "empty",
    "2_normal_": "normal",
    "3_more_": "more",
    "4_little_": "little",
    "5_little_": "little",
}


def scenario_for(filename: str) -> str:
    for prefix, scenario in SCENARIO_BY_PREFIX.items():
        if filename.startswith(prefix):
            return scenario
    if filename == "preview_capture.jpg":
        return "calibration_ref"
    return "layout"


def discover_images() -> list[dict]:
    images: list[dict] = []
    for path in sorted(PHOTO_DIR.glob("*.jpg")):
        images.append({"file": path.name, "scenario": scenario_for(path.name)})
    plate_dir = PHOTO_DIR / "plate"
    if plate_dir.is_dir():
        for path in sorted(plate_dir.glob("*.jpg")):
            images.append({"file": f"plate/{path.name}", "scenario": "plate"})
    return images


def write_manifest(images: list[dict]) -> None:
    policy = load_deck_layout_policy(POLICY_PATH)
    classes = detection_class_names(policy)
    payload = {
        "phase": 3,
        "description": "Bounding-box annotations for movable labware only (fixed modules/trash excluded).",
        "layout_policy": "deck_layout_policy.json",
        "calibration": "deck_calibration.json",
        "bbox_labels_dir": "bbox_labels",
        "classes": classes,
        "detection_slots": detection_slot_names(policy),
        "images": images,
    }
    MANIFEST.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh-manifest", action="store_true", help="Rebuild phase3_manifest.json from all *.jpg")
    p.add_argument("--force", action="store_true", help="Overwrite existing bbox sidecars")
    args = p.parse_args()

    if args.refresh_manifest:
        images = discover_images()
        write_manifest(images)
        print(f"Wrote {len(images)} image(s) to {MANIFEST.resolve()}")

    if not MANIFEST.is_file():
        raise SystemExit(f"Missing {MANIFEST}. Run with --refresh-manifest first.")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    classes = list(manifest.get("classes") or CLASSES)
    out_dir = PHOTO_DIR / str(manifest.get("bbox_labels_dir") or "bbox_labels")
    out_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    for entry in manifest.get("images") or []:
        filename = str(entry.get("file") or "")
        image_path = PHOTO_DIR / filename
        if not image_path.is_file():
            raise SystemExit(f"Missing image: {image_path}")
        dest = out_dir / f"{image_path.stem}.bboxes.json"
        if dest.exists() and not args.force:
            skipped += 1
            continue
        payload = {
            "image_file": filename,
            "phase3_scenario": entry.get("scenario"),
            "classes": classes,
            "boxes": [],
            "notes": "",
        }
        dest.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        written += 1

    print(f"Bbox labels dir: {out_dir.resolve()}")
    print(f"Wrote {written}, skipped {skipped} (total in manifest: {len(manifest.get('images') or [])})")
    print("\nAnnotate:")
    print("  .venv\\Scripts\\python.exe automation\\label_deck_bboxes.py --phase3")
    print("Or all photos directly:")
    print("  .venv\\Scripts\\python.exe automation\\label_deck_bboxes.py --all-photos")


if __name__ == "__main__":
    main()
