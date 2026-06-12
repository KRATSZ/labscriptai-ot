"""Generate PE third-party Flex tip rack labware JSON from pe_tiprack_config.json.

Edit z_dimension_mm (and optionally well_z_mm / grip_height) after measuring the
physical box, then re-run this script before simulate or live pickup tests.
"""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path

LABWARE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = LABWARE_DIR / "pe_tiprack_config.json"
SHARED_DATA = (
    Path(__file__).resolve().parents[2]
    / ".venv"
    / "Lib"
    / "site-packages"
    / "opentrons_shared_data"
    / "data"
    / "labware"
    / "definitions"
    / "2"
)


def _reference_path(load_name: str) -> Path:
    return SHARED_DATA / load_name / "1.json"


def _apply_rack_config(definition: dict, rack_cfg: dict) -> dict:
    out = deepcopy(definition)
    z_dim = float(rack_cfg["z_dimension_mm"])
    well_z = float(rack_cfg["well_z_mm"])
    top_clearance = float(rack_cfg["top_clearance_mm"])
    well_depth = z_dim - well_z - top_clearance

    out["brand"] = {
        "brand": "PE",
        "brandId": [rack_cfg["catalog_id"]],
    }
    out["metadata"]["displayName"] = rack_cfg["display_name"]
    out["dimensions"]["zDimension"] = z_dim
    out["gripHeightFromLabwareBottom"] = float(rack_cfg["grip_height_from_bottom_mm"])
    out["gripForce"] = out.get("gripForce", 16)

    for well in out["wells"].values():
        well["z"] = well_z
        well["depth"] = well_depth

    params = out["parameters"]
    params["loadName"] = rack_cfg["load_name"]
    params["tipLength"] = float(rack_cfg["tip_length_mm"])
    params["tipOverlap"] = float(rack_cfg["tip_overlap_mm"])

    out["namespace"] = "custom_beta"
    out["version"] = 1
    return out


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    written: list[Path] = []

    for key in ("rack_50ul", "rack_200ul"):
        rack_cfg = config[key]
        ref_path = _reference_path(rack_cfg["reference_load_name"])
        if not ref_path.is_file():
            print(f"Missing reference definition: {ref_path}", file=sys.stderr)
            return 1

        definition = json.loads(ref_path.read_text(encoding="utf-8"))
        updated = _apply_rack_config(definition, rack_cfg)
        out_path = LABWARE_DIR / f"{rack_cfg['load_name']}.json"
        out_path.write_text(
            json.dumps(updated, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        written.append(out_path)
        print(
            f"Wrote {out_path.name}: z={rack_cfg['z_dimension_mm']} mm, "
            f"depth={updated['wells']['A1']['depth']:.2f} mm, "
            f"loadName={rack_cfg['load_name']}"
        )

    print(f"Done — {len(written)} definition(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
