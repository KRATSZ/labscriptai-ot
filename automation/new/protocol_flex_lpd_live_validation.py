"""Flex capacitive LPD live validation protocol.

Runs one or more Liquid Presence Detection checks on real hardware and emits
PROBE_RESULT comments (parseable by MCP probe_wells tooling).

Deck (align with protocol_b2_tip_c2_water_to_c1.py):
  B2  opentrons_flex_96_tiprack_1000ul
  C2  nest_12_reservoir_15ml
        A1  filled with conductive aqueous liquid (e.g. DI water) — primary test
        A2  optional empty negative control (detect_presence only)
        A3  waste well for measure_aspirate demo liquid (return to reservoir)
  A3  trash bin (tips only)

Before live run:
  1. Simulate locally (doctor → simulate_protocol).
  2. Confirm conductive Flex tips on B2 and liquid in C2/A1.
  3. Operator opt-in for live motion.

Live expectations (C2/A1 with water):
  detect_presence   → value true
  require_presence  → pass (no error)
  measure_height    → positive mm from well top
  measure_aspirate  → small aspirate at probed depth, dispense to reservoir A3
"""

from __future__ import annotations

import json

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex LPD live validation",
    "author": "LabscriptAI OT",
    "description": "Validate detect/require/measure LPD on Flex with PROBE_RESULT comments.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_str(
        display_name="Test suite",
        variable_name="test_suite",
        choices=[
            {"display_name": "All tests on A1", "value": "all"},
            {"display_name": "Detect only", "value": "detect"},
            {"display_name": "Require only", "value": "require"},
            {"display_name": "Measure height", "value": "measure"},
            {"display_name": "Measure+aspirate", "value": "measure_aspirate"},
            {"display_name": "Negative A2 detect", "value": "negative_detect"},
        ],
        default="all",
    )
    parameters.add_float(
        display_name="Demo aspirate uL",
        variable_name="demo_aspirate_ul",
        default=20,
        minimum=5,
        maximum=100,
    )
    parameters.add_float(
        display_name="Probe clearance mm",
        variable_name="probe_clearance_mm",
        default=1.0,
        minimum=0.5,
        maximum=3.0,
    )


def _json_safe_probe_value(value):
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe_probe_value(v) for k, v in value.items()}
    # Opentrons simulate may return probe result objects instead of plain bool/float.
    for attr in ("detected", "value", "height", "liquid_height"):
        if hasattr(value, attr):
            return _json_safe_probe_value(getattr(value, attr))
    return bool(value)


def _emit_probe_result(
    protocol: protocol_api.ProtocolContext,
    *,
    well: str,
    mode: str,
    success: bool,
    value,
) -> None:
    safe_value = _json_safe_probe_value(value)
    payload = {
        "well": well,
        "mode": mode,
        "success": success,
        "value": safe_value,
    }
    protocol.comment("PROBE_RESULT:" + json.dumps(payload))
    protocol.comment(f"LPD {mode} {well}: success={success} value={safe_value}")


def _aspirate_with_probed_depth(
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    volume: float,
    clearance_mm: float,
) -> float:
    height_mm = float(_json_safe_probe_value(pipette.measure_liquid_height(well)))
    depth_mm = max(0.5, height_mm - clearance_mm)
    pipette.aspirate(volume, well.bottom(depth_mm))
    return height_mm


def _run_detect(
    protocol: protocol_api.ProtocolContext,
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    trash: protocol_api.TrashBin,
) -> None:
    well_name = well.well_name
    pipette.pick_up_tip()
    try:
        present = pipette.detect_liquid_presence(well)
        present_bool = bool(_json_safe_probe_value(present))
        _emit_probe_result(
            protocol,
            well=well_name,
            mode="detect_presence",
            success=True,
            value=present_bool,
        )
    finally:
        pipette.drop_tip(trash)


def _run_require(
    protocol: protocol_api.ProtocolContext,
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    trash: protocol_api.TrashBin,
) -> None:
    well_name = well.well_name
    pipette.pick_up_tip()
    try:
        pipette.require_liquid_presence(well)
        _emit_probe_result(
            protocol,
            well=well_name,
            mode="require_presence",
            success=True,
            value=True,
        )
    finally:
        pipette.drop_tip(trash)


def _run_measure(
    protocol: protocol_api.ProtocolContext,
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    trash: protocol_api.TrashBin,
) -> None:
    well_name = well.well_name
    pipette.pick_up_tip()
    try:
        height_mm = float(_json_safe_probe_value(pipette.measure_liquid_height(well)))
        _emit_probe_result(
            protocol,
            well=well_name,
            mode="measure_height",
            success=True,
            value=height_mm,
        )
    finally:
        pipette.drop_tip(trash)


def _run_measure_aspirate(
    protocol: protocol_api.ProtocolContext,
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    waste_well: protocol_api.Well,
    trash: protocol_api.TrashBin,
    volume: float,
    clearance_mm: float,
) -> None:
    well_name = well.well_name
    pipette.pick_up_tip()
    try:
        height_raw = _aspirate_with_probed_depth(pipette, well, volume, clearance_mm)
        height_mm = float(_json_safe_probe_value(height_raw))
        pipette.dispense(volume, waste_well.top())
        _emit_probe_result(
            protocol,
            well=well_name,
            mode="measure_aspirate",
            success=True,
            value={
                "height_mm": height_mm,
                "aspirate_ul": volume,
                "clearance_mm": clearance_mm,
                "dispense_well": waste_well.well_name,
            },
        )
    finally:
        pipette.drop_tip(trash)


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tip_rack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B2")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C2")

    pipette = protocol.load_instrument(
        "flex_1channel_1000",
        "left",
        tip_racks=[tip_rack],
        liquid_presence_detection=True,
    )

    source = reservoir["A1"]
    negative = reservoir["A2"]
    waste = reservoir["A3"]
    suite = protocol.params.test_suite
    demo_ul = protocol.params.demo_aspirate_ul
    clearance = protocol.params.probe_clearance_mm

    protocol.comment(f"LPD live validation suite={suite}")

    if suite in ("all", "detect"):
        _run_detect(protocol, pipette, source, trash)
    if suite in ("all", "require"):
        _run_require(protocol, pipette, source, trash)
    if suite in ("all", "measure"):
        _run_measure(protocol, pipette, source, trash)
    if suite in ("all", "measure_aspirate"):
        _run_measure_aspirate(protocol, pipette, source, waste, trash, demo_ul, clearance)
    if suite == "negative_detect":
        protocol.comment("LPD negative control: A2 must be empty")
        _run_detect(protocol, pipette, negative, trash)

    protocol.comment("LPD live validation complete")
