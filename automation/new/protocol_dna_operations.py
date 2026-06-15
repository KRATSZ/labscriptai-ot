"""BioSyn DNA operations on Opentrons Flex.

Gibson assembly (row A, 50C) + heat-shock transformation (row B, 4->42->4C)
+ SOC recovery on D1 heater-shaker (37C).

Dry-run uses water; shortened hold times for video capture.
Deck: B1 thermocycler, C1 source (4C), D1 recovery, C2 SOC reservoir.

Labware matches prior BioSyn DNA runs on this Flex (reuse stored calibration):
  TC: nest_96_wellplate_100ul_pcr_full_skirt
  C1: nest_96_wellplate_200ul_flat
  D1: nest_96_wellplate_2ml_deep + opentrons_96_deep_well_adapter
"""

from __future__ import annotations

from opentrons import protocol_api

metadata = {
    "protocolName": "BioSyn DNA Operations - Gibson + Heat Shock",
    "author": "BioSyn Automation",
    "description": (
        "Water-based dry run for Gibson assembly and heat-shock transformation "
        "with SOC recovery. Thermocycler on B1, C1 source, D1 recovery."
    ),
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}

DRY_RUN = True
DROP_TIPS_IN_TRASH = not DRY_RUN  # dry-run: return tips to rack; real run: trash
GIBSON_WELLS = ["A1", "A2", "A3", "A4"]
TRANSFORM_WELLS = ["B1", "B2", "B3", "B4"]
RECOVERY_WELLS = ["A1", "A2", "A3", "A4"]

FRAGMENT_VOL = 20.0
GIBSON_MIX_VOL = 30.0
CELLS_VOL = 50.0
GIBSON_PRODUCT_VOL = 10.0
SOC_VOL = 150.0

GIBSON_PROFILE = [
    {"temperature": 50, "hold_time_seconds": 10},
    {"temperature": 4, "hold_time_seconds": 5},
]
HEAT_SHOCK_PROFILE = [
    {"temperature": 4, "hold_time_seconds": 10},
    {"temperature": 42, "hold_time_seconds": 45},
    {"temperature": 4, "hold_time_seconds": 10},
]
RECOVERY_SEC = 60 if DRY_RUN else 3600

# Prior run labware offsets on Silabrobot001 (192.168.66.102) — attach at run create via API
CALIBRATED_LABWARE = {
    "tc_plate": "opentrons/nest_96_wellplate_100ul_pcr_full_skirt/3",
    "source_plate": "opentrons/nest_96_wellplate_200ul_flat/3",
    "recovery_plate": "opentrons/nest_96_wellplate_2ml_deep/3",
    "reservoir": "opentrons/nest_12_reservoir_15ml/2",
    "tiprack": "opentrons/opentrons_flex_96_tiprack_1000ul/1",
}


def _transfer(
    pipette: protocol_api.InstrumentContext,
    volume: float,
    source,
    dest,
    *,
    mix_after: tuple[int, float] | None = None,
) -> None:
    kwargs: dict = {"new_tip": "always", "trash": DROP_TIPS_IN_TRASH}
    if mix_after is not None:
        kwargs["mix_after"] = mix_after
    pipette.transfer(volume, source, dest, **kwargs)


def run(protocol: protocol_api.ProtocolContext) -> None:
    protocol.load_trash_bin("A3")

    tc_mod = protocol.load_module("thermocyclerModuleV2", "B1")
    temp_mod = protocol.load_module("temperatureModuleV2", "C1")
    hs_mod = protocol.load_module("heaterShakerModuleV1", "D1")

    tc_plate = tc_mod.load_labware("nest_96_wellplate_100ul_pcr_full_skirt")
    source = temp_mod.load_labware("nest_96_wellplate_200ul_flat")
    recovery = hs_mod.load_labware(
        "nest_96_wellplate_2ml_deep",
        adapter="opentrons_96_deep_well_adapter",
    )
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C2")
    tips_1 = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "A2")
    tips_8 = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B2")

    p1000 = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips_1])
    p1000_multi = protocol.load_instrument("flex_8channel_1000", "right", tip_racks=[tips_8])

    frag_wells = [source["A1"], source["A2"], source["A3"]]
    gibson_mix = source["B1"]
    cell_wells = [source["C1"], source["C2"], source["C3"], source["C4"]]
    soc = reservoir["A1"]

    temp_mod.set_temperature(4)
    tc_mod.open_lid()
    tc_mod.set_block_temperature(4)
    hs_mod.close_labware_latch()

    # --- Phase A: Gibson assembly into TC row A ---
    for i, gw in enumerate(GIBSON_WELLS):
        dest = tc_plate[gw]
        frag = frag_wells[min(i, len(frag_wells) - 1)]
        _transfer(p1000, FRAGMENT_VOL, frag, dest, mix_after=(3, 50.0))
        _transfer(p1000, GIBSON_MIX_VOL, gibson_mix, dest, mix_after=(3, 50.0))

    tc_mod.close_lid()
    tc_mod.execute_profile(
        steps=[
            {"temperature": step["temperature"], "hold_time_seconds": step["hold_time_seconds"]}
            for step in GIBSON_PROFILE
        ],
        repetitions=1,
        block_max_volume=100,
    )
    tc_mod.open_lid()

    # --- Phase B: Heat-shock transformation into TC row B ---
    tc_mod.set_block_temperature(4)
    for i, tw in enumerate(TRANSFORM_WELLS):
        dest = tc_plate[tw]
        _transfer(p1000, CELLS_VOL, cell_wells[i], dest)
        _transfer(
            p1000,
            GIBSON_PRODUCT_VOL,
            tc_plate[GIBSON_WELLS[i]],
            dest,
            mix_after=(3, 30.0),
        )

    tc_mod.close_lid()
    tc_mod.execute_profile(
        steps=[
            {"temperature": step["temperature"], "hold_time_seconds": step["hold_time_seconds"]}
            for step in HEAT_SHOCK_PROFILE
        ],
        repetitions=1,
        block_max_volume=100,
    )
    tc_mod.open_lid()

    # --- Phase C: SOC recovery ---
    for well in TRANSFORM_WELLS:
        _transfer(p1000, SOC_VOL, soc, tc_plate[well])

    for tw, rw in zip(TRANSFORM_WELLS, RECOVERY_WELLS, strict=True):
        _transfer(p1000, SOC_VOL, tc_plate[tw], recovery[rw])

    hs_mod.set_target_temperature(37)
    hs_mod.wait_for_temperature()
    hs_mod.set_and_wait_for_shake_speed(400)
    protocol.delay(seconds=RECOVERY_SEC)
    hs_mod.deactivate_shaker()
    hs_mod.deactivate_heater()
    hs_mod.open_labware_latch()

    protocol.pause(
        "Transformation complete. Plate for selection and downstream cloning manually."
        if not DRY_RUN
        else "Transformation dry run complete. Plate for selection and downstream cloning manually."
    )
