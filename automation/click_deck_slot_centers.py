#!/usr/bin/env python3
"""
Optional Phase 0 alternative: click all 12 Flex slot centers for mesh-based mapping.

Default calibration is 4 corners: automation/click_deck_corners.py

Use this tool only if 4-corner homography is not accurate enough. Click each slot
center on the deck floor (not the top of labware).

Click order: A1 A2 A3, B1 B2 B3, C1 C2 C3, D1 D2 D3
  -> click the center of each slot footprint on the metal deck plane.

Requires Pillow:
  .venv\\Scripts\\pip install pillow

Usage (from repo root):
  python automation/click_deck_slot_centers.py
  python automation/click_deck_slot_centers.py --image automation/photo/preview_capture.jpg
  python automation/click_deck_slot_centers.py --apply-to-labels
  python automation/click_deck_slot_centers.py --show

Controls:
  Left-click   place next slot center
  u / Undo     remove last point
  r / Reset    clear all points
  s / Save     write deck_calibration.json (needs 12 points)
  q / Quit
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

from deck_geometry import (
    CORNER_ORDER,
    SLOT_NAMES,
    apply_calibration_to_labels,
    build_slot_polygons_from_centers,
    load_calibration,
    parse_slot_centers_norm,
    slot_polygon_from_corners,
)

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ENV = SCRIPT_DIR / ".env"
DEFAULT_IMAGE = SCRIPT_DIR / "photo" / "preview_capture.jpg"
DEFAULT_OUT = SCRIPT_DIR / "photo" / "deck_calibration.json"
DEFAULT_LABELS_DIR = SCRIPT_DIR / "photo" / "labels"

SLOT_HINTS = {
    "A1": "A1 — row A, column 1 (top-left slot)",
    "A2": "A2 — row A, column 2",
    "A3": "A3 — row A, column 3 (top-right slot)",
    "B1": "B1 — row B, column 1",
    "B2": "B2 — row B, column 2",
    "B3": "B3 — row B, column 3",
    "C1": "C1 — row C, column 1",
    "C2": "C2 — row C, column 2",
    "C3": "C3 — row C, column 3",
    "D1": "D1 — row D, column 1 (bottom-left slot)",
    "D2": "D2 — row D, column 2",
    "D3": "D3 — row D, column 3 (bottom-right slot)",
}


def require_pillow():
    try:
        from PIL import Image, ImageTk  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            "Pillow is required to display JPEG deck photos.\n"
            "Install: .venv\\Scripts\\pip install pillow"
        ) from exc


def load_robot_ip(env_path: Path) -> str | None:
    if not env_path.is_file():
        return None
    text = env_path.read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            _, value = line.split(":", 1)
            ip = value.strip()
            if ip:
                return ip
        m = re.search(r"\d{1,3}(?:\.\d{1,3}){3}", line)
        if m:
            return m.group(0)
    return None


def robot_base_url(env_path: Path) -> str | None:
    ip = load_robot_ip(env_path)
    if not ip:
        return None
    if ip.startswith("http://") or ip.startswith("https://"):
        return ip.rstrip("/")
    return f"http://{ip}:31950"


def round_points(points: dict[str, list[float]], digits: int = 6) -> dict[str, list[float]]:
    return {slot: [round(x, digits), round(y, digits)] for slot, (x, y) in points.items()}


class DeckSlotCenterPicker:
    def __init__(
        self,
        *,
        image_path: Path,
        out_path: Path,
        labels_dir: Path,
        robot_url: str | None,
        initial_centers: dict[str, list[float]] | None,
        guide_corners: list[list[float]] | None,
        apply_to_labels: bool,
        read_only: bool,
    ) -> None:
        require_pillow()
        from PIL import Image, ImageTk

        self.image_path = image_path.resolve()
        self.out_path = out_path.resolve()
        self.labels_dir = labels_dir.resolve()
        self.robot_url = robot_url
        self.apply_to_labels = apply_to_labels
        self.read_only = read_only
        self.guide_corners = guide_corners

        if not self.image_path.is_file():
            raise SystemExit(f"Image not found: {self.image_path}")

        self.pil_image = Image.open(self.image_path)
        self.img_w, self.img_h = self.pil_image.size
        self.centers: dict[str, list[float]] = dict(initial_centers or {})
        self.saved_centers = round_points(self.centers) if self.centers else None
        self.dirty = False

        self.root = tk.Tk()
        self.root.title(f"Deck slot centers — {self.image_path.name}")
        self.root.geometry("1320x900")

        toolbar = ttk.Frame(self.root, padding=6)
        toolbar.pack(fill=tk.X)
        self.status_var = tk.StringVar(value=self._status_text())
        ttk.Label(toolbar, textvariable=self.status_var, wraplength=980).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        if not read_only:
            ttk.Button(toolbar, text="Undo (u)", command=self.undo).pack(side=tk.RIGHT, padx=4)
            ttk.Button(toolbar, text="Reset (r)", command=self.reset).pack(side=tk.RIGHT, padx=4)
            ttk.Button(toolbar, text="Save (s)", command=self.save).pack(side=tk.RIGHT, padx=4)
        ttk.Button(toolbar, text="Quit (q)", command=self.quit_app).pack(side=tk.RIGHT, padx=4)

        help_text = (
            "Click each slot CENTER on the deck floor (metal plane), not the top of tip racks. "
            "Order: A1→A3, B1→B3, C1→C3, D1→D3. Mesh polygons appear after a few points."
        )
        ttk.Label(self.root, text=help_text, padding=(8, 0)).pack(fill=tk.X)

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

        self.photo = ImageTk.PhotoImage(self.pil_image)
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo, tags=("image",))
        self.canvas.configure(scrollregion=(0, 0, self.img_w, self.img_h))

        if not read_only:
            self.canvas.bind("<Button-1>", self.on_click)
        self.root.bind("u", lambda _e: self.undo())
        self.root.bind("r", lambda _e: self.reset())
        self.root.bind("s", lambda _e: self.save())
        self.root.bind("q", lambda _e: self.quit_app())
        self.root.protocol("WM_DELETE_WINDOW", self.quit_app)

        self._redraw_overlay()

    def _next_slot(self) -> str | None:
        for slot in SLOT_NAMES:
            if slot not in self.centers:
                return slot
        return None

    def _status_text(self) -> str:
        nxt = self._next_slot()
        if nxt:
            return f"Next: {SLOT_HINTS[nxt]}  ({len(self.centers)}/12 placed)"
        return "All 12 slot centers placed — press Save (s)"

    def _norm_to_canvas(self, nx: float, ny: float) -> tuple[float, float]:
        return nx * self.img_w, ny * self.img_h

    def _canvas_to_norm(self, cx: float, cy: float) -> tuple[float, float]:
        return max(0.0, min(1.0, cx / self.img_w)), max(0.0, min(1.0, cy / self.img_h))

    def on_click(self, event: tk.Event) -> None:
        nxt = self._next_slot()
        if not nxt:
            return
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        nx, ny = self._canvas_to_norm(cx, cy)
        self.centers[nxt] = [nx, ny]
        self.dirty = True
        self.status_var.set(self._status_text())
        self._redraw_overlay()

    def undo(self) -> None:
        if self.read_only or not self.centers:
            return
        last = [s for s in SLOT_NAMES if s in self.centers][-1]
        del self.centers[last]
        self.dirty = True
        self.status_var.set(self._status_text())
        self._redraw_overlay()

    def reset(self) -> None:
        if self.read_only:
            return
        if self.centers and not messagebox.askyesno("Reset", "Clear all slot centers?"):
            return
        self.centers.clear()
        self.dirty = True
        self.status_var.set(self._status_text())
        self._redraw_overlay()

    def _draw_guide_corners(self) -> None:
        if not self.guide_corners or len(self.guide_corners) != 4:
            return
        pts: list[float] = []
        for nx, ny in self.guide_corners:
            cx, cy = self._norm_to_canvas(nx, ny)
            pts.extend([cx, cy])
        cx0, cy0 = self._norm_to_canvas(self.guide_corners[0][0], self.guide_corners[0][1])
        pts.extend([cx0, cy0])
        self.canvas.create_line(*pts, fill="#666666", dash=(4, 4), width=1, tags="overlay")

    def _redraw_overlay(self) -> None:
        self.canvas.delete("overlay")
        self._draw_guide_corners()

        polys: dict[str, list[list[float]]] | None = None
        if len(self.centers) == 12:
            try:
                polys = build_slot_polygons_from_centers(self.centers)
            except ValueError:
                polys = None

        if polys:
            for slot, poly in polys.items():
                flat: list[float] = []
                for nx, ny in poly:
                    cx, cy = self._norm_to_canvas(nx, ny)
                    flat.extend([cx, cy])
                self.canvas.create_polygon(
                    *flat,
                    fill="",
                    outline="#4488ff",
                    width=1,
                    tags="overlay",
                )

        elif self.guide_corners and len(self.guide_corners) == 4:
            for slot in SLOT_NAMES:
                if slot in self.centers:
                    continue
                poly = slot_polygon_from_corners(slot, self.guide_corners)
                flat: list[float] = []
                for nx, ny in poly:
                    cx, cy = self._norm_to_canvas(nx, ny)
                    flat.extend([cx, cy])
                self.canvas.create_polygon(
                    *flat,
                    fill="",
                    outline="#333333",
                    dash=(2, 4),
                    width=1,
                    tags="overlay",
                )

        for idx, slot in enumerate(SLOT_NAMES):
            if slot not in self.centers:
                continue
            nx, ny = self.centers[slot]
            cx, cy = self._norm_to_canvas(nx, ny)
            r = 6
            self.canvas.create_oval(
                cx - r,
                cy - r,
                cx + r,
                cy + r,
                outline="#00ff66",
                width=2,
                tags="overlay",
            )
            self.canvas.create_text(
                cx + 10,
                cy - 10,
                text=slot,
                fill="#00ff66",
                anchor=tk.NW,
                font=("Segoe UI", 10, "bold"),
                tags="overlay",
            )
            self.canvas.create_text(
                12,
                18 + idx * 16,
                text=f"{slot}: [{nx:.4f}, {ny:.4f}]",
                fill="#7dffaa",
                anchor=tk.NW,
                font=("Consolas", 9),
                tags="overlay",
            )

    def save(self) -> None:
        if self.read_only:
            return
        if len(self.centers) != 12:
            messagebox.showwarning("Incomplete", "Place all 12 slot centers before saving.")
            return

        rounded = round_points(self.centers)
        payload = {
            "robot": self.robot_url,
            "calibration_method": "slot_centers_v1",
            "corner_order": CORNER_ORDER,
            "reference_image": self.image_path.name,
            "image_size": {"width": self.img_w, "height": self.img_h},
            "slot_centers_norm": rounded,
            "optional_deck_corners_norm": self.guide_corners,
            "calibrated_at": datetime.now(timezone.utc).isoformat(),
            "notes": (
                "12 slot centers on the deck floor plane. Prefer this over 4-corner homography "
                "for wide-angle Flex cameras. Reuse for all photos with the same camera settings."
            ),
        }
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self.out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        labels_updated = 0
        if self.apply_to_labels:
            labels_updated = apply_calibration_to_labels(self.labels_dir, payload)

        self.saved_centers = rounded
        self.dirty = False
        msg = f"Saved:\n{self.out_path}"
        if labels_updated:
            msg += f"\n\nUpdated {labels_updated} label sidecar(s)."
        messagebox.showinfo("Saved", msg)
        self.status_var.set(f"Saved {self.out_path.name}")

    def quit_app(self) -> None:
        if (
            not self.read_only
            and len(self.centers) == 12
            and self.dirty
            and self.saved_centers != round_points(self.centers)
        ):
            if messagebox.askyesno("Unsaved", "Save calibration before quitting?"):
                self.save()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--env", type=Path, default=DEFAULT_ENV)
    p.add_argument("--labels-dir", type=Path, default=DEFAULT_LABELS_DIR)
    p.add_argument("--apply-to-labels", action="store_true")
    p.add_argument("--show", action="store_true")
    p.add_argument("--from-calibration", type=Path, default=None)
    args = p.parse_args()

    cal_path = args.from_calibration or args.out
    existing = load_calibration(cal_path)
    initial = parse_slot_centers_norm(existing.get("slot_centers_norm")) if existing else None
    guide_corners = existing.get("optional_deck_corners_norm") if existing else None
    if guide_corners is not None and (
        not isinstance(guide_corners, list) or len(guide_corners) != 4
    ):
        guide_corners = None

    if args.show and not initial:
        raise SystemExit(f"No slot_centers_norm in {cal_path}")

    picker = DeckSlotCenterPicker(
        image_path=args.image,
        out_path=args.out,
        labels_dir=args.labels_dir,
        robot_url=robot_base_url(args.env),
        initial_centers=initial,
        guide_corners=guide_corners,
        apply_to_labels=args.apply_to_labels,
        read_only=bool(args.show),
    )
    picker.run()


if __name__ == "__main__":
    main()
