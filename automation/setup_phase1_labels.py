#!/usr/bin/env python3
"""
Create Phase 1 slot-label sidecars for the five representative deck photos.

Reads automation/photo/phase1_manifest.json and copies calibration fields from
deck_calibration.json (slot_centers_norm preferred, optional corners fallback).

Usage (from repo root):
  python automation/setup_phase1_labels.py
  python automation/setup_phase1_labels.py --force
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from deck_geometry import SLOT_NAMES, load_calibration, parse_slot_centers_norm

SCRIPT_DIR = Path(__file__).resolve().parent
PHOTO_DIR = SCRIPT_DIR / "photo"
MANIFEST = PHOTO_DIR / "phase1_manifest.json"
CALIBRATION = PHOTO_DIR / "deck_calibration.json"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing Phase 1 label sidecars",
    )
    args = p.parse_args()

    if not MANIFEST.is_file():
        raise SystemExit(f"Missing manifest: {MANIFEST}")

    calibration = load_calibration(CALIBRATION)
    if not calibration:
        raise SystemExit(
            f"Missing {CALIBRATION}. Run Phase 0 first:\n"
            "  python automation/click_deck_corners.py --apply-to-labels"
        )

    corners = calibration.get("optional_deck_corners_norm")
    if not isinstance(corners, list) or len(corners) != 4:
        raise SystemExit("deck_calibration.json is missing valid optional_deck_corners_norm.")
    centers = parse_slot_centers_norm(calibration.get("slot_centers_norm"))

    manifest = load_json(MANIFEST)
    labels_dir = PHOTO_DIR / str(manifest.get("labels_dir") or "labels")
    labels_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    missing_images: list[str] = []

    for entry in manifest.get("images") or []:
        filename = str(entry.get("file") or "").strip()
        if not filename:
            continue
        image_path = PHOTO_DIR / filename
        if not image_path.is_file():
            missing_images.append(filename)
            continue

        dest = labels_dir / f"{image_path.stem}.labels.json"
        if dest.exists() and not args.force:
            skipped += 1
            continue

        payload = {
            "image_file": filename,
            "phase1_scenario": entry.get("scenario"),
            "phase1_hint": entry.get("hint", ""),
            "slots": {slot: "unknown" for slot in SLOT_NAMES},
            "notes": "",
            "calibration_method": calibration.get("calibration_method"),
        }
        payload["optional_deck_corners_norm"] = corners
        payload["calibration_method"] = calibration.get("calibration_method") or "deck_corners_v1"
        if str(calibration.get("calibration_method") or "") == "slot_centers_v1" and centers:
            payload["slot_centers_norm"] = centers

        dest.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        written += 1

    print(f"Phase 1 labels dir: {labels_dir.resolve()}")
    print(f"Wrote {written} sidecar(s), skipped existing: {skipped}")
    if missing_images:
        raise SystemExit("Missing image(s):\n  " + "\n  ".join(missing_images))

    print("\nNext: label slots interactively")
    print("  .venv\\Scripts\\python.exe automation\\label_deck_slots.py --phase1")


if __name__ == "__main__":
    main()
