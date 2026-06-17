"""BioSyn Flex DNA operations — Gibson assembly + heat shock + recovery (Video 2).

Deck: A1/B1 Thermocycler, C1 source (4C), D1 recovery (Heater-Shaker), C2 SOC reservoir.
Dry-run uses water, short TC holds, and a manual-transfer pause before recovery.
"""

from __future__ import annotations

from opentrons import protocol_api

metadata = {
    "protocolName": "BioSyn — DNA ops (Gibson + heat shock)",
    "author": "LabscriptAI OT",
    "description": "Gibson row A, heat shock row B, SOC + 37C recovery on D1.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}

DECK_MAP = {
    "trash": "A3",
    "tiprack_1ch": "A2",
    "tiprack_8ch": "B2",
    "reservoir": "C2",
    "temp_module": "C1",
    "thermocycler": "B1",
    "heater_shaker": "D1",
}

SOURCE_MAP = {
    "fragment_1": "A1",
    "fragment_2": "A2",
    "fragment_3": "A3",
    "gibson_mix": "B1",
    "competent_cells": ["C1", "C2", "C3", "C4"],
    "diluent": "H12",
}

VOLUME_MAP = {
    "fragment_ul": 30.0,
    "fragment_3_ul": 20.0,
    "gibson_mix_ul": 20.0,
    "competent_ul": 50.0,
    "gibson_product_ul": 30.0,
    "soc_ul": 150.0,
}

GIBSON_WELLS = ["A1", "A2", "A3", "A4"]
TRANSFORM_WELLS = ["B1", "B2", "B3", "B4"]
RECOVERY_WELLS = ["A1", "A2", "A3", "A4"]

GIBSON_PROFILE_DRY = [
    {"temperature": 50, "hold_time_seconds": 10},
    {"temperature": 4, "hold_time_seconds": 5},
]

GIBSON_PROFILE_REAL = [
    {"temperature": 50, "hold_time_minutes": 30},
    {"temperature": 4, "hold_time_minutes": 10},
]

HEAT_SHOCK_PROFILE_DRY = [
    {"temperature": 4, "hold_time_seconds": 10},
    {"temperature": 42, "hold_time_seconds": 45},
    {"temperature": 4, "hold_time_seconds": 10},
]

HEAT_SHOCK_PROFILE_REAL = [
    {"temperature": 4, "hold_time_minutes": 30},
    {"temperature": 42, "hold_time_seconds": 90},
    {"temperature": 4, "hold_time_minutes": 3},
]


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_bool(
        display_name="Dry run (short hold)",
        variable_name="dry_run",
        default=True,
    )
    parameters.add_int(
        display_name="Recovery (dry, sec)",
        variable_name="recovery_seconds",
        default=60,
        minimum=30,
        maximum=600,
    )
    parameters.add_int(
        display_name="Recovery (real, min)",
        variable_name="recovery_minutes",
        default=60,
        minimum=5,
        maximum=180,
    )
    parameters.add_bool(
        display_name="Use fragment 3",
        variable_name="use_fragment_3",
        default=False,
    )


def _transfer_1ch(
    pipette: protocol_api.InstrumentContext,
    volume: float,
    source_plate: protocol_api.Labware,
    source_well: str,
    dest_plate: protocol_api.Labware,
    dest_well: str,
    mix_after: bool = False,
) -> None:
    dest = dest_plate[dest_well]
    pipette.pick_up_tip()
    pipette.aspirate(volume, source_plate[source_well])
    pipette.dispense(volume, dest)
    if mix_after:
        pipette.mix(repetitions=3, volume=min(volume * 2, 150.0), location=dest)
    pipette.return_tip()


def _run_tc_profile(
    tc_mod: protocol_api.ThermocyclerContext,
    steps: list[dict],
    block_max_volume: float,
) -> None:
    tc_mod.execute_profile(steps=steps, repetitions=1, block_max_volume=block_max_volume)


def run(protocol: protocol_api.ProtocolContext) -> None:
    dry_run = protocol.params.dry_run
    vol = VOLUME_MAP
    block_vol = 100.0

    protocol.load_trash_bin(DECK_MAP["trash"])
    tiprack_1 = protocol.load_labware(
        "opentrons_flex_96_tiprack_1000ul", DECK_MAP["tiprack_1ch"]
    )
    tiprack_8 = protocol.load_labware(
        "opentrons_flex_96_tiprack_1000ul", DECK_MAP["tiprack_8ch"]
    )
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", DECK_MAP["reservoir"])

    temp_mod = protocol.load_module("temperatureModuleV2", DECK_MAP["temp_module"])
    source = temp_mod.load_labware("nest_96_wellplate_200ul_flat")

    tc_mod = protocol.load_module("thermocyclerModuleV2", DECK_MAP["thermocycler"])
    tc_plate = tc_mod.load_labware("nest_96_wellplate_100ul_pcr_full_skirt")

    hs_mod = protocol.load_module("heaterShakerModuleV1", DECK_MAP["heater_shaker"])
    hs_mod.close_labware_latch()
    recovery = hs_mod.load_labware(
        "nest_96_wellplate_2ml_deep",
        adapter="opentrons_96_deep_well_adapter",
    )

    p1 = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tiprack_1])
    p8 = protocol.load_instrument("flex_8channel_1000", "right", tip_racks=[tiprack_8])

    temp_mod.set_temperature(4)

    protocol.comment("=== Phase A: Gibson assembly on Thermocycler row A ===")

    tc_mod.open_lid()
    tc_mod.set_block_temperature(4, block_max_volume=block_vol)

    for well in GIBSON_WELLS:
        _transfer_1ch(
            p1,
            vol["fragment_ul"],
            source,
            SOURCE_MAP["fragment_1"],
            tc_plate,
            well,
        )
        _transfer_1ch(
            p1,
            vol["fragment_ul"],
            source,
            SOURCE_MAP["fragment_2"],
            tc_plate,
            well,
        )
        if protocol.params.use_fragment_3:
            _transfer_1ch(
                p1,
                vol["fragment_3_ul"],
                source,
                SOURCE_MAP["fragment_3"],
                tc_plate,
                well,
            )
        _transfer_1ch(
            p1,
            vol["gibson_mix_ul"],
            source,
            SOURCE_MAP["gibson_mix"],
            tc_plate,
            well,
            mix_after=True,
        )

    tc_mod.close_lid()
    gibson_profile = GIBSON_PROFILE_DRY if dry_run else GIBSON_PROFILE_REAL
    _run_tc_profile(tc_mod, gibson_profile, block_vol)
    tc_mod.open_lid()

    protocol.comment("=== Phase B: heat shock on Thermocycler row B ===")

    tc_mod.set_block_temperature(4, block_max_volume=block_vol)

    for src_cell, dest_well in zip(SOURCE_MAP["competent_cells"], TRANSFORM_WELLS):
        _transfer_1ch(p1, vol["competent_ul"], source, src_cell, tc_plate, dest_well)

    for gibson_well, transform_well in zip(GIBSON_WELLS, TRANSFORM_WELLS):
        _transfer_1ch(
            p1,
            vol["gibson_product_ul"],
            tc_plate,
            gibson_well,
            tc_plate,
            transform_well,
            mix_after=True,
        )

    tc_mod.close_lid()
    heat_profile = HEAT_SHOCK_PROFILE_DRY if dry_run else HEAT_SHOCK_PROFILE_REAL
    _run_tc_profile(tc_mod, heat_profile, block_vol)
    tc_mod.open_lid()

    protocol.comment("=== Phase C: SOC addition ===")

    p1.pick_up_tip()
    for well in TRANSFORM_WELLS:
        p1.aspirate(vol["soc_ul"], reservoir["A1"])
        p1.dispense(vol["soc_ul"], tc_plate[well])
    p1.return_tip()

    protocol.pause(
        msg=(
            "Manually transfer transformants (TC row B / wells B1-B4) to recovery "
            "plate on D1 Heater-Shaker, then resume for 37C recovery."
        )
    )

    protocol.comment("=== Phase D: 37C recovery on Heater-Shaker ===")

    hs_mod.close_labware_latch()
    hs_mod.set_and_wait_for_temperature(37)
    hs_mod.set_and_wait_for_shake_speed(400)

    if dry_run:
        protocol.delay(
            seconds=protocol.params.recovery_seconds,
            msg="Dry-run recovery — use real timing for production",
        )
    else:
        protocol.delay(
            minutes=protocol.params.recovery_minutes,
            msg="Transformation recovery at 37C",
        )

    hs_mod.deactivate_shaker()
    hs_mod.deactivate_heater()
    hs_mod.open_labware_latch()

    protocol.pause(msg="Transformation complete. Plate for selection manually.")
