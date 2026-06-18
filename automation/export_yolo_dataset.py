#!/usr/bin/env python3
"""
Export Phase 3 bbox sidecars to Ultralytics YOLO dataset layout.

Reads automation/photo/bbox_labels/*.bboxes.json and phase3_manifest.json.

Usage (from repo root):
  python automation/export_yolo_dataset.py
  python automation/export_yolo_dataset.py --out vision/data/deck_phase3
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from deck_geometry import detection_class_names, load_deck_layout_policy

SCRIPT_DIR = Path(__file__).resolve().parent
PHOTO_DIR = SCRIPT_DIR / "photo"
MANIFEST = PHOTO_DIR / "phase3_manifest.json"
BBOX_DIR = PHOTO_DIR / "bbox_labels"
POLICY_PATH = SCRIPT_DIR / "deck_layout_policy.json"


def bbox_norm_to_yolo_line(cls_id: int, bbox: list[float]) -> str:
    x1, y1, x2, y2 = bbox
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    cx = x1 + w / 2.0
    cy = y1 + h / 2.0
    return f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--out",
        type=Path,
        default=SCRIPT_DIR.parent / "vision" / "data" / "deck_phase3",
        help="YOLO dataset root",
    )
    p.add_argument(
        "--split",
        choices=("train", "all-train"),
        default="all-train",
        help="all-train: copy all images to train/ (small MVP set)",
    )
    args = p.parse_args()

    if not MANIFEST.is_file():
        raise SystemExit(f"Missing {MANIFEST}")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    policy = load_deck_layout_policy(POLICY_PATH)
    classes: list[str] = list(manifest.get("classes") or detection_class_names(policy))

    out_root: Path = args.out
    img_dir = out_root / "images" / "train"
    lbl_dir = out_root / "labels" / "train"
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    exported = 0
    total_boxes = 0
    skipped_boxes = 0
    missing_sidecars: list[str] = []

    for entry in manifest.get("images") or []:
        filename = str(entry.get("file") or "")
        image_path = PHOTO_DIR / filename
        sidecar = BBOX_DIR / f"{image_path.stem}.bboxes.json"
        if not image_path.is_file():
            raise SystemExit(f"Missing image: {image_path}")
        if not sidecar.is_file():
            missing_sidecars.append(filename)
            continue

        data = json.loads(sidecar.read_text(encoding="utf-8"))
        boxes = data.get("boxes") or []
        lines: list[str] = []
        for box in boxes:
            cls = str(box.get("class") or box.get("cls") or "")
            if cls == "tiprack":
                cls = "tiprack_200"
            if cls not in classes:
                skipped_boxes += 1
                continue
            bbox = box.get("bbox_norm") or box.get("bbox")
            if not isinstance(bbox, list) or len(bbox) < 4:
                continue
            lines.append(bbox_norm_to_yolo_line(classes.index(cls), bbox))
            total_boxes += 1

        stem = image_path.stem
        shutil.copy2(image_path, img_dir / image_path.name)
        (lbl_dir / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        exported += 1

    yaml_path = out_root / "data.yaml"
    yaml_path.write_text(
        "\n".join(
            [
                f"path: {out_root.resolve().as_posix()}",
                "train: images/train",
                "val: images/train",
                f"nc: {len(classes)}",
                "names:",
                *[f"  {i}: {name}" for i, name in enumerate(classes)],
                "",
            ]
        ),
        encoding="utf-8",
    )

    print(f"Exported {exported} image(s), {total_boxes} box(es)")
    if skipped_boxes:
        print(f"Skipped {skipped_boxes} box(es) with non-detection classes (module/trash/etc.)")
    print(f"Dataset: {out_root.resolve()}")
    print(f"data.yaml: {yaml_path.resolve()}")
    if missing_sidecars:
        print(f"\nMissing bbox sidecars ({len(missing_sidecars)}):")
        for name in missing_sidecars:
            print(f"  - {name}")
        print("\nAnnotate first:")
        print("  python automation/label_deck_bboxes.py --phase3")


if __name__ == "__main__":
    main()
