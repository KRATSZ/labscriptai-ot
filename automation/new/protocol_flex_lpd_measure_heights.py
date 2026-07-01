"""Flex LPD — measure liquid height across reservoir + plate wells.

Deck:
  B2  opentrons_flex_96_tiprack_1000ul
  C2  nest_12_reservoir_15ml   — measure A1, A2, A3
  D2  nest_96_wellplate_200ul_flat — measure A1, A2, B1, B2 (2×2)
  A3  trash bin

Uses one tip for the full height survey (no aspiration).
Each result is emitted as PROBE_RESULT JSON in run comments.
"""

from __future__ import annotations

import json

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex LPD height survey",
    "author": "LabscriptAI OT",
    "description": "measure_liquid_height on C2 A1-A3 and D2 2x2 wells.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def _json_safe_probe_value(value):
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    for attr in ("detected", "value", "height", "liquid_height"):
        if hasattr(value, attr):
            return _json_safe_probe_value(getattr(value, attr))
    return bool(value)


def _measure_and_report(
    protocol: protocol_api.ProtocolContext,
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    *,
    slot: str,
) -> None:
    well_name = well.well_name
    height_mm = float(_json_safe_probe_value(pipette.measure_liquid_height(well)))
    payload = {
        "well": well_name,
        "slot": slot,
        "mode": "measure_height",
        "success": True,
        "value": height_mm,
    }
    protocol.comment("PROBE_RESULT:" + json.dumps(payload))
    protocol.comment(f"height {slot}/{well_name}: {height_mm:.3f} mm above well bottom")


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tip_rack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B2")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C2")
    plate = protocol.load_labware("nest_96_wellplate_200ul_flat", "D2")

    pipette = protocol.load_instrument(
        "flex_1channel_1000",
        "left",
        tip_racks=[tip_rack],
        liquid_presence_detection=True,
    )

    reservoir_wells = ["A1", "A2", "A3"]
    plate_wells = ["A1", "A2", "B1", "B2"]

    protocol.comment("LPD height survey start")

    pipette.pick_up_tip()
    try:
        for well_name in reservoir_wells:
            _measure_and_report(protocol, pipette, reservoir[well_name], slot="C2")
        for well_name in plate_wells:
            _measure_and_report(protocol, pipette, plate[well_name], slot="D2")
    finally:
        pipette.drop_tip(trash)

    protocol.comment("LPD height survey complete")
