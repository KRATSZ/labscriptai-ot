#!/usr/bin/env python3
"""
Phase 1: annotate Flex deck slot occupancy on photos with deck grid overlay.

Requires Pillow and deck_calibration.json from Phase 0 (4-corner homography).

Usage (from repo root):
  python automation/label_deck_slots.py --phase1
  python automation/label_deck_slots.py --image automation/photo/1_empty_deck_....jpg

Controls:
  Left-click slot   cycle label for that slot
  Right-click slot  set to empty
  0 empty  1 tiprack  2 plate  3 reservoir  4 module  5 trash_bin  9 unknown
  s / Save          write labels sidecar
  n / p             next / previous image (--phase1 or --images list)
  a                 mark all slots empty (modules still need manual fix)
  q / Quit          exit (prompts if unsaved)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

from click_deck_corners import require_pillow
from deck_geometry import (
    SLOT_NAMES,
    load_calibration,
    map_point_to_slot,
    resolve_slot_mapping,
)

SCRIPT_DIR = Path(__file__).resolve().parent
PHOTO_DIR = SCRIPT_DIR / "photo"
MANIFEST = PHOTO_DIR / "phase1_manifest.json"
CALIBRATION = PHOTO_DIR / "deck_calibration.json"
LABELS_DIR = PHOTO_DIR / "labels"

SLOT_LABELS = [
    "unknown",
    "empty",
    "tiprack",
    "plate",
    "reservoir",
    "module",
    "trash_bin",
]

LABEL_COLORS = {
    "unknown": "#666666",
    "empty": "#1f6b3a",
    "tiprack": "#c9a800",
    "plate": "#dddddd",
    "reservoir": "#0088aa",
    "module": "#cc6600",
    "trash_bin": "#aa2244",
}

KEY_TO_LABEL = {
    "0": "empty",
    "1": "tiprack",
    "2": "plate",
    "3": "reservoir",
    "4": "module",
    "5": "trash_bin",
    "9": "unknown",
}


def load_phase1_images() -> list[Path]:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    out: list[Path] = []
    for entry in data.get("images") or []:
        path = PHOTO_DIR / str(entry["file"])
        if path.is_file():
            out.append(path)
    return out


def sidecar_path(image_path: Path) -> Path:
    return LABELS_DIR / f"{image_path.stem}.labels.json"


def load_sidecar(image_path: Path, calibration: dict | None) -> dict:
    path = sidecar_path(image_path)
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        slots = data.get("slots") or {}
        merged = {slot: str(slots.get(slot, "unknown")) for slot in SLOT_NAMES}
        data["slots"] = merged
        if calibration:
            if calibration.get("slot_centers_norm") and not data.get("slot_centers_norm"):
                data["slot_centers_norm"] = calibration["slot_centers_norm"]
            if calibration.get("optional_deck_corners_norm") and not data.get("optional_deck_corners_norm"):
                data["optional_deck_corners_norm"] = calibration["optional_deck_corners_norm"]
            if calibration.get("calibration_method"):
                data["calibration_method"] = calibration["calibration_method"]
        return data
    payload = {
        "image_file": image_path.name,
        "slots": {slot: "unknown" for slot in SLOT_NAMES},
        "notes": "",
    }
    if calibration:
        if calibration.get("slot_centers_norm"):
            payload["slot_centers_norm"] = calibration["slot_centers_norm"]
        if calibration.get("optional_deck_corners_norm"):
            payload["optional_deck_corners_norm"] = calibration["optional_deck_corners_norm"]
        if calibration.get("calibration_method"):
            payload["calibration_method"] = calibration["calibration_method"]
    return payload


class DeckSlotLabeler:
    def __init__(
        self,
        *,
        image_paths: list[Path],
        mapping: dict,
        calibration: dict | None,
        start_index: int = 0,
    ) -> None:
        require_pillow()
        from PIL import Image, ImageTk

        if not image_paths:
            raise SystemExit("No images to label.")

        self.image_paths = image_paths
        self.mapping = mapping
        self.slot_polygons = mapping.get("slot_polygons") or {}
        self.mapping_method = mapping.get("method") or "none"
        self.calibration = calibration
        self.index = max(0, min(start_index, len(image_paths) - 1))
        self.pending_label: str | None = None
        self.saved_snapshot: str | None = None

        self.root = tk.Tk()
        self.root.title("Deck slot labeler — Phase 1")
        self.root.geometry("1320x900")

        toolbar = ttk.Frame(self.root, padding=6)
        toolbar.pack(fill=tk.X)

        self.status_var = tk.StringVar()
        ttk.Label(toolbar, textvariable=self.status_var, wraplength=980).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        ttk.Button(toolbar, text="Prev (p)", command=self.prev_image).pack(side=tk.RIGHT, padx=3)
        ttk.Button(toolbar, text="Next (n)", command=self.next_image).pack(side=tk.RIGHT, padx=3)
        ttk.Button(toolbar, text="Save (s)", command=self.save).pack(side=tk.RIGHT, padx=3)
        ttk.Button(toolbar, text="Quit (q)", command=self.quit_app).pack(side=tk.RIGHT, padx=3)

        legend = (
            "Click slot to cycle label. Keys: 0 empty | 1 tiprack | 2 plate | 3 reservoir | "
            "4 module | 5 trash_bin | 9 unknown | a all empty"
        )
        ttk.Label(self.root, text=legend, padding=(8, 0)).pack(fill=tk.X)

        canvas_frame = ttk.Frame(self.root)
        canvas_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)
        self.canvas = tk.Canvas(canvas_frame, bg="#202020", highlightthickness=0)
        h_scroll = ttk.Scrollbar(canvas_frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        v_scroll = ttk.Scrollbar(canvas_frame, orient=tk.VERTICAL, command=self.canvas.yview)
        self.canvas.configure(xscrollcommand=h_scroll.set, yscrollcommand=v_scroll.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        v_scroll.grid(row=0, column=1, sticky="ns")
        h_scroll.grid(row=1, column=0, sticky="ew")
        canvas_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)

        self.canvas.bind("<Button-1>", self.on_left_click)
        self.canvas.bind("<Button-3>", self.on_right_click)
        self.root.bind("s", lambda _e: self.save())
        self.root.bind("n", lambda _e: self.next_image())
        self.root.bind("p", lambda _e: self.prev_image())
        self.root.bind("q", lambda _e: self.quit_app())
        self.root.bind("a", lambda _e: self.mark_all_empty())
        for key in KEY_TO_LABEL:
            self.root.bind(key, lambda e, k=key: self.set_pending_label(KEY_TO_LABEL[k]))

        self.photo = None
        self.pil_image = None
        self.img_w = 0
        self.img_h = 0
        self.sidecar: dict = {}
        self.load_image(self.index)

        self.root.protocol("WM_DELETE_WINDOW", self.quit_app)

    def _norm_to_canvas(self, nx: float, ny: float) -> tuple[float, float]:
        return nx * self.img_w, ny * self.img_h

    def _canvas_to_norm(self, cx: float, cy: float) -> tuple[float, float]:
        return cx / self.img_w, cy / self.img_h

    def _snapshot(self) -> str:
        return json.dumps(self.sidecar.get("slots") or {}, sort_keys=True)

    def _update_status(self) -> None:
        remaining = sum(
            1 for slot in SLOT_NAMES if self.sidecar["slots"].get(slot) == "unknown"
        )
        hint = self.sidecar.get("phase1_hint") or ""
        pending = f" | paint: {self.pending_label}" if self.pending_label else ""
        self.status_var.set(
            f"[{self.index + 1}/{len(self.image_paths)}] {self.image_paths[self.index].name} "
            f"| unknown slots: {remaining}/12{pending}"
            + (f" | {hint}" if hint else "")
        )

    def load_image(self, index: int) -> None:
        from PIL import Image, ImageTk

        if self.saved_snapshot and self._snapshot() != self.saved_snapshot:
            if messagebox.askyesno("Unsaved", "Save current labels before switching image?"):
                self.save()

        self.index = index
        image_path = self.image_paths[self.index]
        self.pil_image = Image.open(image_path)
        self.img_w, self.img_h = self.pil_image.size
        self.photo = ImageTk.PhotoImage(self.pil_image)
        self.sidecar = load_sidecar(image_path, self.calibration)
        self.saved_snapshot = self._snapshot()

        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo, tags=("image",))
        self.canvas.configure(scrollregion=(0, 0, self.img_w, self.img_h))
        self._redraw_slots()
        self._update_status()

    def _redraw_slots(self) -> None:
        self.canvas.delete("overlay")
        if not self.slot_polygons:
            return
        for slot in SLOT_NAMES:
            poly_norm = self.slot_polygons.get(slot)
            if not poly_norm:
                continue
            flat: list[float] = []
            for nx, ny in poly_norm:
                cx, cy = self._norm_to_canvas(nx, ny)
                flat.extend([cx, cy])
            label = self.sidecar["slots"].get(slot, "unknown")
            fill = LABEL_COLORS.get(label, "#666666")
            self.canvas.create_polygon(
                *flat,
                fill=fill,
                stipple="gray50",
                outline="#ffffff",
                width=1,
                tags=("overlay", f"slot:{slot}"),
            )
            cx, cy = self._slot_label_position(slot)
            text = f"{slot}\n{label}"
            self.canvas.create_text(
                cx,
                cy,
                text=text,
                fill="#000000" if label in {"plate", "tiprack"} else "#ffffff",
                font=("Segoe UI", 9, "bold"),
                justify=tk.CENTER,
                tags="overlay",
            )

    def _slot_label_position(self, slot: str) -> tuple[float, float]:
        poly = self.slot_polygons.get(slot) or []
        if poly:
            nx = sum(p[0] for p in poly) / len(poly)
            ny = sum(p[1] for p in poly) / len(poly)
            return self._norm_to_canvas(nx, ny)
        return self._norm_to_canvas(0.5, 0.5)

    def _slot_at(self, cx: float, cy: float) -> str | None:
        nx, ny = self._canvas_to_norm(cx, cy)
        slot, _notes = map_point_to_slot(
            nx,
            ny,
            slot_polygons=self.slot_polygons,
            slot_centers=self.mapping.get("slot_centers"),
        )
        return slot

    def _cycle_label(self, slot: str) -> None:
        current = self.sidecar["slots"].get(slot, "unknown")
        if current not in SLOT_LABELS:
            current = "unknown"
        nxt = SLOT_LABELS[(SLOT_LABELS.index(current) + 1) % len(SLOT_LABELS)]
        self.sidecar["slots"][slot] = nxt
        self._redraw_slots()
        self._update_status()

    def _set_label(self, slot: str, label: str) -> None:
        self.sidecar["slots"][slot] = label
        self._redraw_slots()
        self._update_status()

    def on_left_click(self, event: tk.Event) -> None:
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        slot = self._slot_at(cx, cy)
        if not slot:
            return
        if self.pending_label:
            self._set_label(slot, self.pending_label)
            self.pending_label = None
        else:
            self._cycle_label(slot)

    def on_right_click(self, event: tk.Event) -> None:
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        slot = self._slot_at(cx, cy)
        if slot:
            self._set_label(slot, "empty")

    def set_pending_label(self, label: str) -> None:
        self.pending_label = label
        self._update_status()

    def mark_all_empty(self) -> None:
        if not messagebox.askyesno("All empty", "Set every slot to empty?"):
            return
        for slot in SLOT_NAMES:
            self.sidecar["slots"][slot] = "empty"
        self._redraw_slots()
        self._update_status()

    def save(self) -> None:
        path = sidecar_path(self.image_paths[self.index])
        path.parent.mkdir(parents=True, exist_ok=True)
        self.sidecar["image_file"] = self.image_paths[self.index].name
        if self.calibration:
            if self.calibration.get("slot_centers_norm"):
                self.sidecar["slot_centers_norm"] = self.calibration["slot_centers_norm"]
            if self.calibration.get("optional_deck_corners_norm"):
                self.sidecar["optional_deck_corners_norm"] = self.calibration["optional_deck_corners_norm"]
            if self.calibration.get("calibration_method"):
                self.sidecar["calibration_method"] = self.calibration["calibration_method"]
        path.write_text(json.dumps(self.sidecar, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.saved_snapshot = self._snapshot()
        messagebox.showinfo("Saved", f"Wrote\n{path}")

    def next_image(self) -> None:
        if self.index + 1 < len(self.image_paths):
            self.load_image(self.index + 1)

    def prev_image(self) -> None:
        if self.index > 0:
            self.load_image(self.index - 1)

    def quit_app(self) -> None:
        if self.saved_snapshot and self._snapshot() != self.saved_snapshot:
            if messagebox.askyesno("Unsaved", "Save labels before quitting?"):
                self.save()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--phase1", action="store_true", help="Label the five Phase 1 representative images")
    p.add_argument("--image", type=Path, action="append", help="Image path (repeatable)")
    p.add_argument("--calibration", type=Path, default=CALIBRATION)
    p.add_argument("--start", type=int, default=0, help="Start index within image list")
    args = p.parse_args()

    cal = load_calibration(args.calibration)
    if not cal:
        raise SystemExit(f"Missing or invalid calibration: {args.calibration}")
    mapping = resolve_slot_mapping(cal)
    if mapping["method"] == "none":
        raise SystemExit(
            "Calibration has no optional_deck_corners_norm.\n"
            "Run: python automation/click_deck_corners.py --apply-to-labels"
        )

    if args.phase1:
        images = load_phase1_images()
    elif args.image:
        images = [path.expanduser().resolve() for path in args.image]
    else:
        raise SystemExit("Use --phase1 or --image PATH")

    app = DeckSlotLabeler(
        image_paths=images,
        mapping=mapping,
        calibration=cal,
        start_index=args.start,
    )
    app.run()


if __name__ == "__main__":
    main()
