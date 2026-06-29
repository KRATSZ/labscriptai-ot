#!/usr/bin/env python3
"""
Phase 3: draw bounding boxes on deck photos for YOLO training.

Requires Pillow + deck_calibration.json (grid overlay guide).

Usage (from repo root):
  python automation/setup_phase3_labels.py --refresh-manifest
  python automation/label_deck_bboxes.py --phase3
  python automation/label_deck_bboxes.py --all-photos

Controls:
  Drag LMB           draw bbox with current class
  Click box          select
  1-5                set class (see toolbar)
  d / Delete         delete selected box
  u / Undo           remove last box
  s / Save           write bbox sidecar
  n / p              next / previous image
  q / Quit

Output: automation/photo/bbox_labels/<stem>.bboxes.json
Export YOLO dataset: python automation/export_yolo_dataset.py
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

from click_deck_corners import require_pillow
from deck_geometry import (
    detection_class_names,
    detection_slot_names,
    fixed_slot_names,
    fixed_slot_note,
    is_fixed_slot,
    load_calibration,
    load_deck_layout_policy,
    resolve_slot_mapping,
    slot_for_point,
)

SCRIPT_DIR = Path(__file__).resolve().parent
PHOTO_DIR = SCRIPT_DIR / "photo"
MANIFEST = PHOTO_DIR / "phase3_manifest.json"
CALIBRATION = PHOTO_DIR / "deck_calibration.json"
BBOX_DIR = PHOTO_DIR / "bbox_labels"
SLOT_LABELS_DIR = PHOTO_DIR / "labels"
POLICY_PATH = SCRIPT_DIR / "deck_layout_policy.json"

CLASSES = detection_class_names()
KEY_TO_CLASS = {str(i + 1): c for i, c in enumerate(CLASSES)}

CLASS_COLORS = {
    "tiprack_50": "#d4c400",
    "tiprack_200": "#00aaff",
    "tiprack_1000": "#8844ff",
    "plate": "#eeeeee",
    "reservoir": "#00cccc",
}


@dataclass
class BBox:
    cls: str
    x1: float
    y1: float
    x2: float
    y2: float

    def normalized(self) -> list[float]:
        x1, x2 = sorted((self.x1, self.x2))
        y1, y2 = sorted((self.y1, self.y2))
        return [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)]

    @classmethod
    def from_norm(cls, name: str, coords: list[float]) -> BBox:
        x1, y1, x2, y2 = coords
        return cls(name, float(x1), float(y1), float(x2), float(y2))


def load_phase3_images() -> list[Path]:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return [PHOTO_DIR / str(entry["file"]) for entry in data.get("images") or [] if (PHOTO_DIR / str(entry["file"])).is_file()]


def load_all_photos() -> list[Path]:
    return sorted(PHOTO_DIR.glob("*.jpg"))


def sidecar_path(image_path: Path) -> Path:
    return BBOX_DIR / f"{image_path.stem}.bboxes.json"


def load_sidecar(image_path: Path, classes: list[str]) -> dict:
    path = sidecar_path(image_path)
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = {
            "image_file": image_path.name,
            "classes": classes,
            "boxes": [],
            "notes": "",
        }
    data["classes"] = classes
    return data


def boxes_from_sidecar(data: dict, allowed_classes: list[str]) -> list[BBox]:
    out: list[BBox] = []
    for item in data.get("boxes") or []:
        cls = str(item.get("class") or item.get("cls") or "module")
        if cls == "tiprack":
            cls = "tiprack_200"
        if cls not in allowed_classes:
            continue
        bbox = item.get("bbox_norm") or item.get("bbox")
        if isinstance(bbox, list) and len(bbox) >= 4:
            out.append(BBox.from_norm(cls, bbox[:4]))
    return out


def slot_hints(image_path: Path, policy: dict) -> dict[str, str]:
    path = SLOT_LABELS_DIR / f"{image_path.stem}.labels.json"
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    slots = data.get("slots") or {}
    detect_slots = set(detection_slot_names(policy))
    out: dict[str, str] = {}
    for slot, raw in slots.items():
        slot = str(slot).upper()
        if slot not in detect_slots:
            continue
        val = str(raw).lower()
        if val in {"empty", "unknown", "module", "trash_bin"}:
            continue
        if val == "tiprack":
            val = "tiprack_200"
        out[slot] = val
    return out


class DeckBBoxLabeler:
    def __init__(
        self,
        *,
        image_paths: list[Path],
        mapping: dict,
        classes: list[str],
        policy: dict,
        start_index: int = 0,
    ) -> None:
        require_pillow()
        from PIL import Image, ImageTk

        if not image_paths:
            raise SystemExit("No images to label.")

        self.image_paths = image_paths
        self.slot_polygons = mapping.get("slot_polygons") or {}
        self.policy = policy
        self.fixed_slots = fixed_slot_names(policy)
        self.detect_slots = set(detection_slot_names(policy))
        self.classes = classes
        self.index = max(0, min(start_index, len(image_paths) - 1))
        self.current_class = classes[1] if len(classes) > 1 else classes[0]
        self.boxes: list[BBox] = []
        self.selected_idx: int | None = None
        self.saved_snapshot: str | None = None
        self.drag_start: tuple[float, float] | None = None
        self.drag_rect_id: int | None = None
        self.hints: dict[str, str] = {}

        self.root = tk.Tk()
        self.root.title("Deck bbox labeler — Phase 3")
        self.root.geometry("1360x920")

        toolbar = ttk.Frame(self.root, padding=6)
        toolbar.pack(fill=tk.X)
        self.status_var = tk.StringVar()
        ttk.Label(toolbar, textvariable=self.status_var, wraplength=900).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        ttk.Button(toolbar, text="Prev (p)", command=self.prev_image).pack(side=tk.RIGHT, padx=3)
        ttk.Button(toolbar, text="Next (n)", command=self.next_image).pack(side=tk.RIGHT, padx=3)
        ttk.Button(toolbar, text="Save (s)", command=self.save).pack(side=tk.RIGHT, padx=3)
        ttk.Button(toolbar, text="Quit (q)", command=self.quit_app).pack(side=tk.RIGHT, padx=3)

        legend = " | ".join(f"{i + 1}={c}" for i, c in enumerate(classes))
        ttk.Label(self.root, text=f"Class keys: {legend}", padding=(8, 0)).pack(fill=tk.X)
        ttk.Label(
            self.root,
            text=(
                "Fixed (no bbox): A1 PCR, B1/C1 temp module, D1 shaker, A3 trash. "
                "Detect only in A2,B2,B3,C2,C3,D2,D3."
            ),
            padding=(8, 0),
        ).pack(fill=tk.X)

        body = ttk.Frame(self.root)
        body.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)
        canvas_frame = ttk.Frame(body)
        canvas_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.canvas = tk.Canvas(canvas_frame, bg="#202020", highlightthickness=0)
        h_scroll = ttk.Scrollbar(canvas_frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        v_scroll = ttk.Scrollbar(canvas_frame, orient=tk.VERTICAL, command=self.canvas.yview)
        self.canvas.configure(xscrollcommand=h_scroll.set, yscrollcommand=v_scroll.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        v_scroll.grid(row=0, column=1, sticky="ns")
        h_scroll.grid(row=1, column=0, sticky="ew")
        canvas_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)

        side = ttk.Frame(body, width=260)
        side.pack(side=tk.RIGHT, fill=tk.Y, padx=(8, 0))
        ttk.Label(side, text="Boxes").pack(anchor=tk.W)
        self.box_list = tk.Listbox(side, height=24, width=36)
        self.box_list.pack(fill=tk.BOTH, expand=True)
        self.box_list.bind("<<ListboxSelect>>", self.on_list_select)

        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_motion)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.root.bind("d", lambda _e: self.delete_selected())
        self.root.bind("<Delete>", lambda _e: self.delete_selected())
        self.root.bind("u", lambda _e: self.undo())
        self.root.bind("s", lambda _e: self.save())
        self.root.bind("n", lambda _e: self.next_image())
        self.root.bind("p", lambda _e: self.prev_image())
        self.root.bind("q", lambda _e: self.quit_app())
        for key, cls in KEY_TO_CLASS.items():
            self.root.bind(key, lambda e, c=cls: self.set_class(c))

        self.photo = None
        self.pil_image = None
        self.img_w = 0
        self.img_h = 0
        self.load_image(self.index)
        self.root.protocol("WM_DELETE_WINDOW", self.quit_app)

    def set_class(self, cls: str) -> None:
        self.current_class = cls
        self._update_status()

    def _update_status(self) -> None:
        self.status_var.set(
            f"[{self.index + 1}/{len(self.image_paths)}] {self.image_paths[self.index].name} "
            f"| class={self.current_class} | boxes={len(self.boxes)}"
        )

    def _norm_to_canvas(self, nx: float, ny: float) -> tuple[float, float]:
        return nx * self.img_w, ny * self.img_h

    def _canvas_to_norm(self, cx: float, cy: float) -> tuple[float, float]:
        return max(0.0, min(1.0, cx / self.img_w)), max(0.0, min(1.0, cy / self.img_h))

    def _snapshot(self) -> str:
        return json.dumps([b.normalized() + [b.cls] for b in self.boxes])

    def load_image(self, index: int) -> None:
        from PIL import Image, ImageTk

        if self.saved_snapshot and self._snapshot() != self.saved_snapshot:
            if messagebox.askyesno("Unsaved", "Save bbox labels before switching?"):
                self.save()

        self.index = index
        image_path = self.image_paths[self.index]
        self.pil_image = Image.open(image_path)
        self.img_w, self.img_h = self.pil_image.size
        self.photo = ImageTk.PhotoImage(self.pil_image)
        sidecar = load_sidecar(image_path, self.classes)
        self.boxes = boxes_from_sidecar(sidecar, self.classes)
        self.hints = slot_hints(image_path, self.policy)
        self.selected_idx = None
        self.saved_snapshot = self._snapshot()

        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo, tags=("image",))
        self.canvas.configure(scrollregion=(0, 0, self.img_w, self.img_h))
        self._redraw()
        self._update_status()

    def _redraw(self) -> None:
        self.canvas.delete("overlay")
        self._draw_grid()
        for idx, box in enumerate(self.boxes):
            self._draw_box(box, idx, selected=(idx == self.selected_idx))
        self._refresh_list()

    def _draw_grid(self) -> None:
        if not self.slot_polygons:
            return
        for slot, poly in self.slot_polygons.items():
            flat: list[float] = []
            for nx, ny in poly:
                cx, cy = self._norm_to_canvas(float(nx), float(ny))
                flat.extend([cx, cy])
            fixed = slot in self.fixed_slots
            if fixed:
                self.canvas.create_polygon(
                    *flat,
                    fill="#442222",
                    stipple="gray50",
                    outline="#aa4444",
                    width=1,
                    tags="overlay",
                )
            else:
                self.canvas.create_polygon(
                    *flat,
                    fill="",
                    outline="#335588",
                    dash=(3, 4),
                    width=1,
                    tags="overlay",
                )
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            cx, cy = self._norm_to_canvas(sum(xs) / len(xs), sum(ys) / len(ys))
            if fixed:
                text = f"{slot}\nfixed"
            else:
                hint = self.hints.get(slot, "")
                text = f"{slot}\n{hint}" if hint else slot
            color = "#cc6666" if fixed else "#6699cc"
            self.canvas.create_text(
                cx,
                cy,
                text=text,
                fill=color,
                font=("Segoe UI", 8),
                justify=tk.CENTER,
                tags="overlay",
            )

    def _draw_box(self, box: BBox, idx: int, *, selected: bool) -> None:
        x1, y1 = self._norm_to_canvas(box.x1, box.y1)
        x2, y2 = self._norm_to_canvas(box.x2, box.y2)
        color = CLASS_COLORS.get(box.cls, "#ffffff")
        width = 3 if selected else 2
        self.canvas.create_rectangle(
            x1,
            y1,
            x2,
            y2,
            outline=color,
            width=width,
            tags=("overlay", f"box:{idx}"),
        )
        self.canvas.create_text(
            x1 + 4,
            y1 + 4,
            text=box.cls,
            anchor=tk.NW,
            fill=color,
            font=("Segoe UI", 9, "bold"),
            tags="overlay",
        )

    def _refresh_list(self) -> None:
        self.box_list.delete(0, tk.END)
        for i, box in enumerate(self.boxes):
            n = box.normalized()
            self.box_list.insert(tk.END, f"{i + 1}. {box.cls}  [{n[0]:.3f},{n[1]:.3f}]-[{n[2]:.3f},{n[3]:.3f}]")

    def _hit_test(self, cx: float, cy: float) -> int | None:
        nx, ny = self._canvas_to_norm(cx, cy)
        for idx in reversed(range(len(self.boxes))):
            box = self.boxes[idx]
            x1, x2 = sorted((box.x1, box.x2))
            y1, y2 = sorted((box.y1, box.y2))
            if x1 <= nx <= x2 and y1 <= ny <= y2:
                return idx
        return None

    def on_list_select(self, _event: tk.Event) -> None:
        sel = self.box_list.curselection()
        self.selected_idx = int(sel[0]) if sel else None
        self._redraw()

    def on_press(self, event: tk.Event) -> None:
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        hit = self._hit_test(cx, cy)
        if hit is not None:
            self.selected_idx = hit
            self._redraw()
            return
        self.selected_idx = None
        self.drag_start = (cx, cy)
        if self.drag_rect_id is not None:
            self.canvas.delete(self.drag_rect_id)
        color = CLASS_COLORS.get(self.current_class, "#ffffff")
        self.drag_rect_id = self.canvas.create_rectangle(
            cx,
            cy,
            cx,
            cy,
            outline=color,
            width=2,
            dash=(4, 2),
            tags="overlay",
        )

    def on_motion(self, event: tk.Event) -> None:
        if not self.drag_start or self.drag_rect_id is None:
            return
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        x0, y0 = self.drag_start
        self.canvas.coords(self.drag_rect_id, x0, y0, cx, cy)

    def on_release(self, event: tk.Event) -> None:
        if not self.drag_start:
            return
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        x0, y0 = self.drag_start
        nx1, ny1 = self._canvas_to_norm(x0, y0)
        nx2, ny2 = self._canvas_to_norm(cx, cy)
        self.drag_start = None
        if self.drag_rect_id is not None:
            self.canvas.delete(self.drag_rect_id)
            self.drag_rect_id = None
        if abs(nx2 - nx1) < 0.005 or abs(ny2 - ny1) < 0.005:
            return
        cx, cy = (nx1 + nx2) / 2.0, (ny1 + ny2) / 2.0
        slot = slot_for_point(cx, cy, self.slot_polygons)
        if slot and is_fixed_slot(slot, self.policy):
            messagebox.showwarning(
                "Fixed slot",
                f"{slot} is fixed ({fixed_slot_note(slot, self.policy)}). Do not draw bboxes here.",
            )
            return
        if self.current_class not in self.classes:
            messagebox.showwarning("Class", f"Invalid class: {self.current_class}")
            return
        self.boxes.append(BBox(self.current_class, nx1, ny1, nx2, ny2))
        self.selected_idx = len(self.boxes) - 1
        self._redraw()

    def delete_selected(self) -> None:
        if self.selected_idx is None:
            return
        del self.boxes[self.selected_idx]
        self.selected_idx = None
        self._redraw()

    def undo(self) -> None:
        if not self.boxes:
            return
        self.boxes.pop()
        self.selected_idx = None
        self._redraw()

    def save(self) -> None:
        image_path = self.image_paths[self.index]
        path = sidecar_path(image_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = load_sidecar(image_path, self.classes)
        payload["image_file"] = image_path.name
        payload["image_size"] = {"width": self.img_w, "height": self.img_h}
        payload["boxes"] = [{"class": b.cls, "bbox_norm": b.normalized()} for b in self.boxes]
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.saved_snapshot = self._snapshot()
        messagebox.showinfo("Saved", f"Wrote\n{path}\n({len(self.boxes)} boxes)")

    def next_image(self) -> None:
        if self.index + 1 < len(self.image_paths):
            self.load_image(self.index + 1)

    def prev_image(self) -> None:
        if self.index > 0:
            self.load_image(self.index - 1)

    def quit_app(self) -> None:
        if self.saved_snapshot and self._snapshot() != self.saved_snapshot:
            if messagebox.askyesno("Unsaved", "Save before quitting?"):
                self.save()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--phase3", action="store_true", help="Label all images in phase3_manifest.json")
    p.add_argument("--all-photos", action="store_true", help="Label every *.jpg in automation/photo/")
    p.add_argument("--image", type=Path, action="append")
    p.add_argument("--calibration", type=Path, default=CALIBRATION)
    p.add_argument("--start", type=int, default=0)
    args = p.parse_args()

    cal = load_calibration(args.calibration)
    if not cal:
        raise SystemExit(f"Missing calibration: {args.calibration}")
    mapping = resolve_slot_mapping(cal)
    if mapping["method"] == "none":
        raise SystemExit("Need deck_calibration.json with optional_deck_corners_norm")

    policy = load_deck_layout_policy(POLICY_PATH)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    classes = list(manifest.get("classes") or detection_class_names(policy))

    if args.all_photos:
        images = load_all_photos()
    elif args.phase3:
        images = load_phase3_images()
    elif args.image:
        images = [p.expanduser().resolve() for p in args.image]
    else:
        raise SystemExit("Use --phase3, --all-photos, or --image PATH")

    BBOX_DIR.mkdir(parents=True, exist_ok=True)
    app = DeckBBoxLabeler(
        image_paths=images,
        mapping=mapping,
        classes=classes,
        policy=policy,
        start_index=args.start,
    )
    app.run()


if __name__ == "__main__":
    main()
