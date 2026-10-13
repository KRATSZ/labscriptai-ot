#!/usr/bin/env python3
"""Run the vendored LogicPass package on one analyze JSON.

The checker is copied into automation/vendor so this plugin does not import
Opentrons-Lab-Agent from disk. Prints one JSON object.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[3] / "automation" / "vendor"
sys.path.insert(0, str(VENDOR))

from labscriptai.benchmark.logicpass import PhysicalSetup, evaluate_logicpass, load_analyze_json
from labscriptai.benchmark.logicpass.labware_capacity import (
    infer_max_volume_ul_from_labware_name,
)


def _definition_max_ul(load_name: str, version):
    """Real per-well max µL from the installed opentrons labware definition."""
    try:
        from opentrons_shared_data import labware as shared_labware
    except Exception:
        return None
    versions = [int(version)] if isinstance(version, int) and version else [1, 2, 3]
    for schema in (2, 3):
        for ver in versions:
            try:
                definition = shared_labware.load_definition(load_name, ver, schema)
            except Exception:
                continue
            volumes = [
                well.get("totalLiquidVolume")
                for well in definition.get("wells", {}).values()
                if isinstance(well, dict) and well.get("totalLiquidVolume") is not None
            ]
            if volumes:
                return float(max(volumes))
    return None


def _parse_definition_uri(uri):
    parts = str(uri).strip("/").split("/")
    if len(parts) >= 3:
        try:
            return parts[-2], int(parts[-1])
        except ValueError:
            return parts[-2], None
    return None, None


def resolve_capacity_sources(adapter):
    """Return {labware_id: {load_name, max_ul, source}} with source in
    ``definition`` (real, from the installed opentrons definitions) or
    ``name_hint`` (best-effort guess parsed from the labware name) or
    ``unknown``.
    """
    sources = {}
    for item in adapter.labware:
        if not isinstance(item, dict):
            continue
        labware_id = str(item.get("id"))
        load_name = item.get("loadName") or None
        version = item.get("version")
        uri = item.get("definitionUri")
        max_ul = None
        if load_name:
            max_ul = _definition_max_ul(str(load_name), version)
        if max_ul is None and uri:
            uri_name, uri_version = _parse_definition_uri(uri)
            if uri_name:
                max_ul = _definition_max_ul(uri_name, uri_version)
        if max_ul is not None:
            sources[labware_id] = {
                "load_name": load_name or uri,
                "max_ul": max_ul,
                "source": "definition",
                "guessed": False,
            }
            continue
        hint = infer_max_volume_ul_from_labware_name(
            str(load_name or uri or item.get("displayName") or "")
        )
        if hint is not None:
            sources[labware_id] = {
                "load_name": load_name or uri,
                "max_ul": hint,
                "source": "name_hint",
                "guessed": True,
            }
        else:
            sources[labware_id] = {
                "load_name": load_name or uri,
                "max_ul": None,
                "source": "unknown",
                "guessed": True,
            }
    return sources


def main() -> int:
    analysis = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    sim_pass = True if len(sys.argv) < 3 else sys.argv[2] != "false"

    adapter = load_analyze_json(analysis if analysis and analysis.is_file() else None)
    capacity_sources = resolve_capacity_sources(adapter)
    # Real definition capacities are authoritative for LP-L4. Name hints stay
    # as a fallback merged by evaluate_logicpass, but are reported as guesses.
    physical_setup = PhysicalSetup(
        labware_max_ul={
            labware_id: float(entry["max_ul"])
            for labware_id, entry in capacity_sources.items()
            if entry["source"] == "definition"
        }
    )
    result = evaluate_logicpass(sim_pass=sim_pass, adapter=adapter, physical_setup=physical_setup)
    payload = result.to_dict()
    guessed = sorted(
        entry["load_name"]
        for entry in capacity_sources.values()
        if entry["source"] != "definition"
    )
    print(json.dumps({
        "outcome": payload["outcome"],
        "logic_pass": payload["logic_pass"],
        "sim_pass": payload["sim_pass"],
        "final_pass_v2": payload["final_pass_v2"],
        "unevaluable": bool(adapter.unevaluable),
        "issues": [
            {
                "code": issue["code"],
                "step_index": issue["step_index"],
                "command_id": issue["command_id"],
                "well": issue["well"],
                "detail_text": issue["detail_text"],
                "severity": issue["severity"],
            }
            for issue in payload["issues"]
        ],
        "capacity_sources": capacity_sources,
        "guessed_capacity_labware": guessed,
        "capacity_note": (
            "容量按名字猜的器皿（非官方定义，数值可能不准）: "
            + ", ".join(guessed)
            if guessed
            else ""
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())