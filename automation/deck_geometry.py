"""Shared Flex deck geometry for calibration and slot labeling tools."""

from __future__ import annotations

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY_PATH = SCRIPT_DIR / "deck_layout_policy.json"

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

CORNER_ORDER = "A1_A3_D3_D1_clockwise_deck_view"
CORNER_SLOTS = ["A1", "A3", "D3", "D1"]


def slot_row_col(slot: str) -> tuple[int, int]:
    return ord(slot[0]) - ord("A"), int(slot[1]) - 1


def slot_name(row: int, col: int) -> str:
    return f"{chr(ord('A') + row)}{col + 1}"


def deck_bilinear(u: float, v: float, corners: list[list[float]]) -> tuple[float, float]:
    a1, a3, d3, d1 = corners
    top_x = (1 - u) * a1[0] + u * a3[0]
    top_y = (1 - u) * a1[1] + u * a3[1]
    bot_x = (1 - u) * d1[0] + u * d3[0]
    bot_y = (1 - u) * d1[1] + u * d3[1]
    x = (1 - v) * top_x + v * bot_x
    y = (1 - v) * top_y + v * bot_y
    return x, y


def slot_center_from_corners(slot: str, corners: list[list[float]]) -> tuple[float, float]:
    row, col = slot_row_col(slot)
    u = (col + 0.5) / 3.0
    v = (row + 0.5) / 4.0
    return deck_bilinear(u, v, corners)


def slot_polygon_from_corners(slot: str, corners: list[list[float]]) -> list[tuple[float, float]]:
    row, col = slot_row_col(slot)
    u1, u2 = col / 3.0, (col + 1) / 3.0
    v1, v2 = row / 4.0, (row + 1) / 4.0
    return [
        deck_bilinear(u1, v1, corners),
        deck_bilinear(u2, v1, corners),
        deck_bilinear(u2, v2, corners),
        deck_bilinear(u1, v2, corners),
    ]


def point_in_polygon(px: float, py: float, polygon: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if ((y1 > py) != (y2 > py)) and (px < (x2 - x1) * (py - y1) / (y2 - y1 + 1e-12) + x1):
            inside = not inside
    return inside


def _mean_or_none(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _extrapolate_outer(low_center: float, inner_boundary: float) -> float:
    return 2.0 * low_center - inner_boundary


def build_slot_polygons_from_centers(
    centers: dict[str, list[float]],
) -> dict[str, list[list[float]]]:
    """
    Build slot polygons from 12 clicked slot centers (image-normalized coords).

    Uses averaged midlines between neighbor centers; outer edges are extrapolated
    from the first interior boundary so wide-angle decks stay aligned per row/col.
    """
    missing = [s for s in SLOT_NAMES if s not in centers]
    if missing:
        raise ValueError(f"slot_centers_norm missing slots: {', '.join(missing)}")

    col_x = [None, None, None, None]
    for boundary in (1, 2):
        xs: list[float] = []
        for row in range(4):
            left = centers.get(slot_name(row, boundary - 1))
            right = centers.get(slot_name(row, boundary))
            if left and right:
                xs.append((float(left[0]) + float(right[0])) / 2.0)
        col_x[boundary] = _mean_or_none(xs)

    row_y = [None, None, None, None, None]
    for boundary in (1, 2, 3):
        ys: list[float] = []
        for col in range(3):
            up = centers.get(slot_name(boundary - 1, col))
            down = centers.get(slot_name(boundary, col))
            if up and down:
                ys.append((float(up[1]) + float(down[1])) / 2.0)
        row_y[boundary] = _mean_or_none(ys)

    if col_x[1] is None or col_x[2] is None or row_y[1] is None or row_y[3] is None:
        raise ValueError("slot_centers_norm does not span enough of the deck grid")

    col_x[0] = _mean_or_none(
        [
            _extrapolate_outer(float(centers[slot_name(r, 0)][0]), col_x[1])
            for r in range(4)
        ]
    )
    col_x[3] = _mean_or_none(
        [
            _extrapolate_outer(float(centers[slot_name(r, 2)][0]), col_x[2])
            for r in range(4)
        ]
    )
    row_y[0] = _mean_or_none(
        [
            _extrapolate_outer(float(centers[slot_name(0, c)][1]), row_y[1])
            for c in range(3)
        ]
    )
    row_y[4] = _mean_or_none(
        [
            _extrapolate_outer(float(centers[slot_name(3, c)][1]), row_y[3])
            for c in range(3)
        ]
    )

    for idx, val in enumerate(col_x):
        if val is None:
            raise ValueError(f"Could not derive column boundary {idx}")
    for idx, val in enumerate(row_y):
        if val is None:
            raise ValueError(f"Could not derive row boundary {idx}")

    polys: dict[str, list[list[float]]] = {}
    for slot in SLOT_NAMES:
        row, col = slot_row_col(slot)
        poly = [
            [col_x[col], row_y[row]],
            [col_x[col + 1], row_y[row]],
            [col_x[col + 1], row_y[row + 1]],
            [col_x[col], row_y[row + 1]],
        ]
        polys[slot] = poly
    return polys


def map_point_to_slot(
    nx: float,
    ny: float,
    *,
    slot_polygons: dict[str, list[list[float]]] | None = None,
    slot_centers: dict[str, list[float]] | None = None,
) -> tuple[str | None, list[str]]:
    notes: list[str] = []
    if slot_polygons:
        hits = [slot for slot in SLOT_NAMES if point_in_polygon(nx, ny, [tuple(p) for p in slot_polygons[slot]])]
        if len(hits) == 1:
            return hits[0], notes
        if len(hits) > 1:
            notes.append("point_in_multiple_slot_polygons")
            if slot_centers:
                best = min(hits, key=lambda s: _dist2(nx, ny, slot_centers[s]))
                return best, notes

    if slot_centers:
        best_slot = min(SLOT_NAMES, key=lambda s: _dist2(nx, ny, slot_centers[s]))
        notes.append("nearest_slot_center_fallback")
        return best_slot, notes

    return None, notes


def _dist2(nx: float, ny: float, center: list[float]) -> float:
    dx = nx - float(center[0])
    dy = ny - float(center[1])
    return dx * dx + dy * dy


def load_calibration(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def parse_slot_centers_norm(raw: object) -> dict[str, list[float]] | None:
    if not isinstance(raw, dict):
        return None
    out: dict[str, list[float]] = {}
    for slot in SLOT_NAMES:
        pt = raw.get(slot)
        if not isinstance(pt, (list, tuple)) or len(pt) < 2:
            return None
        out[slot] = [float(pt[0]), float(pt[1])]
    return out


def resolve_slot_mapping(calibration: dict | None) -> dict:
    """
    Return mapping config for labeling / vision:
      method: slot_centers_mesh | deck_homography | none

    Default is 4-corner homography. Slot-center mesh is used only when
    calibration_method == slot_centers_v1.
    """
    if not calibration:
        return {"method": "none", "slot_polygons": None, "slot_centers": None, "corners": None}

    method = str(calibration.get("calibration_method") or "").strip()
    corners = calibration.get("optional_deck_corners_norm")
    centers = parse_slot_centers_norm(calibration.get("slot_centers_norm"))

    if method == "slot_centers_v1" and centers:
        polys = build_slot_polygons_from_centers(centers)
        return {
            "method": "slot_centers_mesh",
            "slot_polygons": polys,
            "slot_centers": centers,
            "corners": corners if isinstance(corners, list) else None,
        }

    if isinstance(corners, list) and len(corners) == 4:
        polys = {
            slot: [list(p) for p in slot_polygon_from_corners(slot, corners)]
            for slot in SLOT_NAMES
        }
        return {
            "method": "deck_homography",
            "slot_polygons": polys,
            "slot_centers": None,
            "corners": corners,
        }

    if centers:
        polys = build_slot_polygons_from_centers(centers)
        return {
            "method": "slot_centers_mesh",
            "slot_polygons": polys,
            "slot_centers": centers,
            "corners": None,
        }

    return {"method": "none", "slot_polygons": None, "slot_centers": None, "corners": None}


def apply_calibration_to_labels(labels_dir: Path, calibration: dict) -> int:
    labels_dir.mkdir(parents=True, exist_ok=True)
    updated = 0
    cal_method = str(calibration.get("calibration_method") or "").strip()
    corners = calibration.get("optional_deck_corners_norm")
    centers = calibration.get("slot_centers_norm")

    for path in sorted(labels_dir.glob("*.labels.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if cal_method == "slot_centers_v1" and centers:
            data["slot_centers_norm"] = centers
            data["calibration_method"] = "slot_centers_v1"
            if isinstance(corners, list) and len(corners) == 4:
                data["optional_deck_corners_norm"] = corners
        elif isinstance(corners, list) and len(corners) == 4:
            data["optional_deck_corners_norm"] = corners
            data["calibration_method"] = "deck_corners_v1"
            data.pop("slot_centers_norm", None)
        elif centers:
            data["slot_centers_norm"] = centers
            data["calibration_method"] = cal_method or "slot_centers_v1"

        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        updated += 1
    return updated


def load_deck_layout_policy(path: Path | None = None) -> dict:
    policy_path = path or DEFAULT_POLICY_PATH
    if not policy_path.is_file():
        return {
            "fixed_slots": {},
            "detection_classes": [
                "tiprack_50",
                "tiprack_200",
                "tiprack_1000",
                "reservoir",
                "plate",
            ],
            "detection_slots": [s for s in SLOT_NAMES],
        }
    return json.loads(policy_path.read_text(encoding="utf-8"))


def fixed_slot_names(policy: dict | None = None) -> set[str]:
    policy = policy or load_deck_layout_policy()
    fixed = policy.get("fixed_slots") or {}
    return {str(slot).upper() for slot in fixed}


def detection_slot_names(policy: dict | None = None) -> list[str]:
    policy = policy or load_deck_layout_policy()
    slots = policy.get("detection_slots")
    if isinstance(slots, list) and slots:
        return [str(s).upper() for s in slots]
    fixed = fixed_slot_names(policy)
    return [slot for slot in SLOT_NAMES if slot not in fixed]


def detection_class_names(policy: dict | None = None) -> list[str]:
    policy = policy or load_deck_layout_policy()
    classes = policy.get("detection_classes")
    if isinstance(classes, list) and classes:
        return [str(c) for c in classes]
    return ["tiprack_50", "tiprack_200", "tiprack_1000", "reservoir", "plate"]


def is_fixed_slot(slot: str, policy: dict | None = None) -> bool:
    return str(slot).upper() in fixed_slot_names(policy)


def fixed_slot_note(slot: str, policy: dict | None = None) -> str:
    policy = policy or load_deck_layout_policy()
    entry = (policy.get("fixed_slots") or {}).get(str(slot).upper()) or {}
    return str(entry.get("note") or entry.get("role") or "fixed")


def slot_for_point(
    nx: float,
    ny: float,
    slot_polygons: dict[str, list[list[float]]] | None,
) -> str | None:
    if not slot_polygons:
        return None
    for slot in SLOT_NAMES:
        poly = slot_polygons.get(slot)
        if not poly:
            continue
        if point_in_polygon(nx, ny, [(float(p[0]), float(p[1])) for p in poly]):
            return slot
    return None


def bbox_center_norm(bbox: list[float]) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    x1, x2 = sorted((float(x1), float(x2)))
    y1, y2 = sorted((float(y1), float(y2)))
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0
