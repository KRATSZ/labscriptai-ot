"""Load Flex deck machine profile (fixed slots + detection scope)."""

from __future__ import annotations

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILE = SCRIPT_DIR / "photo" / "deck_machine_profile.json"

DEFAULT_DETECTION_CLASSES = [
    "tiprack_50",
    "tiprack_200",
    "tiprack_1000",
    "reservoir",
    "plate",
]

DEFAULT_FIXED_SLOTS = {
    "A1": "module",
    "B1": "module",
    "C1": "module",
    "D1": "module",
    "A3": "trash_bin",
}


def load_machine_profile(path: Path | None = None) -> dict:
    profile_path = path or DEFAULT_PROFILE
    if not profile_path.is_file():
        return {
            "fixed_slots": {k: {"canonical": v, "detect": False} for k, v in DEFAULT_FIXED_SLOTS.items()},
            "detection_classes": list(DEFAULT_DETECTION_CLASSES),
            "detectable_slots": ["A2", "B2", "B3", "C2", "C3", "D2", "D3"],
        }
    return json.loads(profile_path.read_text(encoding="utf-8"))


def fixed_slot_names(profile: dict | None = None) -> set[str]:
    prof = profile or load_machine_profile()
    fixed = prof.get("fixed_slots") or {}
    return {str(k).upper() for k in fixed.keys()}


def detectable_slot_names(profile: dict | None = None) -> list[str]:
    prof = profile or load_machine_profile()
    slots = prof.get("detectable_slots")
    if isinstance(slots, list) and slots:
        return [str(s).upper() for s in slots]
    all_slots = [
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
    return [s for s in all_slots if s not in fixed_slot_names(prof)]


def detection_classes(profile: dict | None = None) -> list[str]:
    prof = profile or load_machine_profile()
    classes = prof.get("detection_classes")
    if isinstance(classes, list) and classes:
        return [str(c) for c in classes]
    return list(DEFAULT_DETECTION_CLASSES)


def fixed_slot_canonical(slot: str, profile: dict | None = None) -> str | None:
    prof = profile or load_machine_profile()
    entry = (prof.get("fixed_slots") or {}).get(slot.upper())
    if not entry:
        return None
    if isinstance(entry, dict):
        return str(entry.get("canonical") or entry.get("role") or "module")
    return str(entry)
