"""Flex liquid presence detection examples (simulate-first).

Demonstrates all three LPD modes on a single source well.
Enable live execution only with operator opt-in and OPENTRONS_ENABLE_PROBE_WELLS=1.
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex liquid probe example",
    "author": "LabscriptAI OT",
    "description": "detect_presence, require_presence, or measure_height on one source well.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_bool(
        display_name="Use liquid probe",
        variable_name="use_liquid_probe",
        default=True,
    )
    parameters.add_str(
        display_name="Probe mode",
        variable_name="probe_mode",
        choices=[
            {"display_name": "Detect", "value": "detect"},
            {"display_name": "Require", "value": "require"},
            {"display_name": "Measure", "value": "measure"},
            {"display_name": "Measure+aspirate", "value": "measure_aspirate"},
        ],
        default="require",
    )
    parameters.add_float(
        display_name="Aspirate volume uL",
        variable_name="aspirate_volume_ul",
        default=50,
        minimum=5,
        maximum=200,
    )
    parameters.add_float(
        display_name="Probe clearance mm",
        variable_name="probe_clearance_mm",
        default=1.0,
        minimum=0.5,
        maximum=5.0,
    )


def aspirate_with_probed_depth(
    pipette: protocol_api.InstrumentContext,
    well: protocol_api.Well,
    volume: float,
    clearance_mm: float,
) -> float:
    """Measure liquid height, then aspirate at probed depth minus clearance."""
    height_mm = pipette.measure_liquid_height(well)
    aspirate_depth_mm = max(0.5, height_mm - clearance_mm)
    pipette.aspirate(volume, well.bottom(aspirate_depth_mm))
    return height_mm


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tip_rack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B2")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C2")

    use_probe = protocol.params.use_liquid_probe
    probe_mode = protocol.params.probe_mode

    pipette = protocol.load_instrument(
        "flex_1channel_1000",
        "left",
        tip_racks=[tip_rack],
        liquid_presence_detection=use_probe,
    )

    source = reservoir["A1"]

    if not use_probe:
        protocol.comment("Liquid probe disabled; skipping LPD.")
        return

    pipette.pick_up_tip()
    try:
        if probe_mode == "detect":
            present = pipette.detect_liquid_presence(source)
            protocol.comment(f"detect_liquid_presence={present}")
        elif probe_mode == "require":
            pipette.require_liquid_presence(source)
            protocol.comment("require_liquid_presence=pass")
        elif probe_mode == "measure_aspirate":
            height_mm = aspirate_with_probed_depth(
                pipette,
                source,
                protocol.params.aspirate_volume_ul,
                protocol.params.probe_clearance_mm,
            )
            protocol.comment(
                f"measure_and_aspirate: height_mm={height_mm}, "
                f"volume_ul={protocol.params.aspirate_volume_ul}"
            )
            pipette.dispense(protocol.params.aspirate_volume_ul, trash)
        else:
            height_mm = pipette.measure_liquid_height(source)
            protocol.comment(f"measure_liquid_height_mm={height_mm}")
    finally:
        pipette.drop_tip(trash)
