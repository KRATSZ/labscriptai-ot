#!/usr/bin/env python3
"""
Phase 0: click 4 Flex deck corners for homography calibration.

Optional alternative (12 slot centers): automation/click_deck_slot_centers.py

Corner order matches vision_check.py (normalized image coords [nx, ny] in 0..1):
  1. A1  top-left
  2. A3  top-right
  3. D3  bottom-right
  4. D1  bottom-left

Requires Pillow for JPEG display:
  .venv\\Scripts\\pip install pillow

Usage (from repo root):
  python automation/click_deck_corners.py
  python automation/click_deck_corners.py --image automation/photo/preview_capture.jpg
  python automation/click_deck_corners.py --apply-to-labels
  python automation/click_deck_corners.py --show

Controls:
  Left-click   place next corner (A1 -> A3 -> D3 -> D1)
  u / Undo     remove last corner
  r / Reset    clear all corners
  s / Save     write JSON (needs 4 corners)
  q / Quit     exit (prompts to save if 4 corners and unsaved)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tkinter as tk
from datetime import datetime, timezone
from pathlib import Path
from tkinter import messagebox, ttk

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ENV = SCRIPT_DIR / ".env"
DEFAULT_IMAGE = SCRIPT_DIR / "photo" / "preview_capture.jpg"
DEFAULT_OUT = SCRIPT_DIR / "photo" / "deck_calibration.json"
DEFAULT_LABELS_DIR = SCRIPT_DIR / "photo" / "labels"

CORNER_ORDER = "A1_A3_D3_D1_clockwise_deck_view"
CORNER_SLOTS = ["A1", "A3", "D3", "D1"]
CORNER_HINTS = {
    "A1": "A1 — top-left (A row, column 1)",
    "A3": "A3 — top-right (A row, column 3)",
    "D3": "D3 — bottom-right (D row, column 3)",
    "D1": "D1 — bottom-left (D row, column 1)",
}
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


def require_pillow():
    try:
        from PIL import Image, ImageTk  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            "Pillow is required to display JPEG deck photos.\n"
            "Install: .venv\\Scripts\\pip install pillow"
        ) from exc


def load_calibration(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    corners = data.get("optional_deck_corners_norm")
    if not isinstance(corners, list) or len(corners) != 4:
        return None
    return data


def deck_bilinear(u: float, v: float, corners: list[list[float]]) -> tuple[float, float]:
    """Map deck plane (u,v) in [0,1]^2 to normalized image coords."""
    a1, a3, d3, d1 = corners
    top_x = (1 - u) * a1[0] + u * a3[0]
    top_y = (1 - u) * a1[1] + u * a3[1]
    bot_x = (1 - u) * d1[0] + u * d3[0]
    bot_y = (1 - u) * d1[1] + u * d3[1]
    x = (1 - v) * top_x + v * bot_x
    y = (1 - v) * top_y + v * bot_y
    return x, y


def slot_center_norm(slot: str, corners: list[list[float]]) -> tuple[float, float]:
    row = ord(slot[0]) - ord("A")
    col = int(slot[1]) - 1
    u = (col + 0.5) / 3.0
    v = (row + 0.5) / 4.0
    return deck_bilinear(u, v, corners)


def round_corners(corners: list[list[float]], digits: int = 6) -> list[list[float]]:
    return [[round(x, digits), round(y, digits)] for x, y in corners]


def apply_corners_to_labels(labels_dir: Path, corners: list[list[float]]) -> int:
    if not labels_dir.is_dir():
        return 0
    rounded = round_corners(corners)
    updated = 0
    for path in sorted(labels_dir.glob("*.labels.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        data["optional_deck_corners_norm"] = rounded
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        updated += 1
    return updated


class DeckCornerPicker:
    def __init__(
        self,
        *,
        image_path: Path,
        out_path: Path,
        labels_dir: Path,
        robot_url: str | None,
        initial_corners: list[list[float]] | None,
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

        if not self.image_path.is_file():
            raise SystemExit(f"Image not found: {self.image_path}")

        self.pil_image = Image.open(self.image_path)
        self.img_w, self.img_h = self.pil_image.size
        self.corners: list[list[float]] = []
        if initial_corners:
            self.corners = [list(map(float, pt)) for pt in initial_corners[:4]]
        self.saved_corners: list[list[float]] | None = (
            round_corners(self.corners) if initial_corners else None
        )
        self.dirty = False

        self.root = tk.Tk()
        self.root.title(f"Deck corner picker — {self.image_path.name}")
        self.root.geometry("1280x860")

        toolbar = ttk.Frame(self.root, padding=6)
        toolbar.pack(fill=tk.X)

        self.status_var = tk.StringVar(value=self._status_text())
        ttk.Label(toolbar, textvariable=self.status_var, wraplength=900).pack(side=tk.LEFT, fill=tk.X, expand=True)

        if not read_only:
            ttk.Button(toolbar, text="Undo (u)", command=self.undo).pack(side=tk.RIGHT, padx=4)
            ttk.Button(toolbar, text="Reset (r)", command=self.reset).pack(side=tk.RIGHT, padx=4)
            ttk.Button(toolbar, text="Save (s)", command=self.save).pack(side=tk.RIGHT, padx=4)
        ttk.Button(toolbar, text="Quit (q)", command=self.quit_app).pack(side=tk.RIGHT, padx=4)

        help_text = (
            "Click the deck working surface corners in order: A1 → A3 → D3 → D1. "
            "Use slightly inset points on visible metal edges; avoid glare and foreground occlusion."
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

    def _status_text(self) -> str:
        if len(self.corners) < 4:
            slot = CORNER_SLOTS[len(self.corners)]
            return f"Next corner: {CORNER_HINTS[slot]}  ({len(self.corners)}/4 placed)"
        return "All 4 corners placed — press Save (s) to write deck_calibration.json"

    def _norm_to_canvas(self, nx: float, ny: float) -> tuple[float, float]:
        return nx * self.img_w, ny * self.img_h

    def _canvas_to_norm(self, cx: float, cy: float) -> tuple[float, float]:
        nx = max(0.0, min(1.0, cx / self.img_w))
        ny = max(0.0, min(1.0, cy / self.img_h))
        return nx, ny

    def on_click(self, event: tk.Event) -> None:
        if self.read_only or len(self.corners) >= 4:
            return
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        nx, ny = self._canvas_to_norm(cx, cy)
        self.corners.append([nx, ny])
        self.dirty = True
        self.status_var.set(self._status_text())
        self._redraw_overlay()

    def undo(self) -> None:
        if self.read_only or not self.corners:
            return
        self.corners.pop()
        self.dirty = True
        self.status_var.set(self._status_text())
        self._redraw_overlay()

    def reset(self) -> None:
        if self.read_only:
            return
        if self.corners and not messagebox.askyesno("Reset", "Clear all corner points?"):
            return
        self.corners.clear()
        self.dirty = True
        self.status_var.set(self._status_text())
        self._redraw_overlay()

    def _redraw_overlay(self) -> None:
        self.canvas.delete("overlay")

        if len(self.corners) == 4:
            self._draw_grid_overlay()

        for idx, (nx, ny) in enumerate(self.corners):
            cx, cy = self._norm_to_canvas(nx, ny)
            r = 7
            self.canvas.create_oval(
                cx - r,
                cy - r,
                cx + r,
                cy + r,
                outline="#00ff66",
                width=2,
                tags="overlay",
            )
            label = CORNER_SLOTS[idx]
            self.canvas.create_text(
                cx + 12,
                cy - 12,
                text=label,
                fill="#00ff66",
                anchor=tk.NW,
                font=("Segoe UI", 11, "bold"),
                tags="overlay",
            )
            self.canvas.create_text(
                12,
                18 + idx * 18,
                text=f"{label}: [{nx:.4f}, {ny:.4f}]",
                fill="#7dffaa",
                anchor=tk.NW,
                font=("Consolas", 10),
                tags="overlay",
            )

        if len(self.corners) >= 2:
            pts: list[float] = []
            for nx, ny in self.corners:
                cx, cy = self._norm_to_canvas(nx, ny)
                pts.extend([cx, cy])
            if len(self.corners) == 4:
                nx0, ny0 = self.corners[0]
                cx0, cy0 = self._norm_to_canvas(nx0, ny0)
                pts.extend([cx0, cy0])
            self.canvas.create_line(*pts, fill="#ffcc00", width=2, tags="overlay")

    def _draw_grid_overlay(self) -> None:
        corners = self.corners
        for col in range(1, 3):
            u = col / 3.0
            x1, y1 = deck_bilinear(u, 0.0, corners)
            x2, y2 = deck_bilinear(u, 1.0, corners)
            cx1, cy1 = self._norm_to_canvas(x1, y1)
            cx2, cy2 = self._norm_to_canvas(x2, y2)
            self.canvas.create_line(cx1, cy1, cx2, cy2, fill="#4488ff", width=1, tags="overlay")

        for row in range(1, 4):
            v = row / 4.0
            x1, y1 = deck_bilinear(0.0, v, corners)
            x2, y2 = deck_bilinear(1.0, v, corners)
            cx1, cy1 = self._norm_to_canvas(x1, y1)
            cx2, cy2 = self._norm_to_canvas(x2, y2)
            self.canvas.create_line(cx1, cy1, cx2, cy2, fill="#4488ff", width=1, tags="overlay")

        for slot in SLOT_NAMES:
            nx, ny = slot_center_norm(slot, corners)
            cx, cy = self._norm_to_canvas(nx, ny)
            self.canvas.create_text(
                cx,
                cy,
                text=slot,
                fill="#88bbff",
                font=("Segoe UI", 9),
                tags="overlay",
            )

    def save(self) -> None:
        if self.read_only:
            return
        if len(self.corners) != 4:
            messagebox.showwarning("Incomplete", "Place all 4 corners before saving.")
            return

        rounded = round_corners(self.corners)
        payload = {
            "robot": self.robot_url,
            "calibration_method": "deck_corners_v1",
            "corner_order": CORNER_ORDER,
            "reference_image": self.image_path.name,
            "image_size": {"width": self.img_w, "height": self.img_h},
            "optional_deck_corners_norm": rounded,
            "calibrated_at": datetime.now(timezone.utc).isoformat(),
            "notes": (
                "Normalized image coordinates for vision_check homography. "
                "Reuse for all photos from the same robot camera settings."
            ),
        }
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self.out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        labels_updated = 0
        if self.apply_to_labels:
            from deck_geometry import apply_calibration_to_labels

            labels_updated = apply_calibration_to_labels(self.labels_dir, payload)

        self.saved_corners = rounded
        self.dirty = False

        msg = f"Saved:\n{self.out_path}"
        if labels_updated:
            msg += f"\n\nUpdated optional_deck_corners_norm in {labels_updated} label file(s)."
        messagebox.showinfo("Saved", msg)
        self.status_var.set(f"Saved {self.out_path.name}")

    def quit_app(self) -> None:
        if (
            not self.read_only
            and len(self.corners) == 4
            and self.dirty
            and round_corners(self.corners) != self.saved_corners
        ):
            if messagebox.askyesno("Unsaved corners", "Save calibration before quitting?"):
                self.save()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--image",
        type=Path,
        default=DEFAULT_IMAGE,
        help=f"Reference deck photo (default: {DEFAULT_IMAGE})",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Calibration JSON output (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--env",
        type=Path,
        default=DEFAULT_ENV,
        help=f"Env file with robot IP (default: {DEFAULT_ENV})",
    )
    p.add_argument(
        "--labels-dir",
        type=Path,
        default=DEFAULT_LABELS_DIR,
        help=f"Slot label sidecars directory (default: {DEFAULT_LABELS_DIR})",
    )
    p.add_argument(
        "--apply-to-labels",
        action="store_true",
        help="After save, copy corners into all labels/*.labels.json sidecars",
    )
    p.add_argument(
        "--show",
        action="store_true",
        help="Open existing calibration overlay without editing",
    )
    p.add_argument(
        "--from-calibration",
        type=Path,
        default=None,
        help="Load corner points from an existing calibration JSON",
    )
    args = p.parse_args()

    cal_path = args.from_calibration or args.out
    existing = load_calibration(cal_path)
    initial_corners = None
    if existing:
        initial_corners = existing.get("optional_deck_corners_norm")

    if args.show and not initial_corners:
        raise SystemExit(f"No corners found in {cal_path}")

    picker = DeckCornerPicker(
        image_path=args.image,
        out_path=args.out,
        labels_dir=args.labels_dir,
        robot_url=robot_base_url(args.env),
        initial_corners=initial_corners,
        apply_to_labels=args.apply_to_labels,
        read_only=bool(args.show),
    )
    picker.run()


if __name__ == "__main__":
    main()
