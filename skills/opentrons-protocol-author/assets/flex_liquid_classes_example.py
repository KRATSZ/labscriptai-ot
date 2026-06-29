"""Minimal Flex example: Opentrons-verified liquid classes (water / ethanol_80 / glycerol_50).

Uses official API — do not duplicate hand-tuned flow tables here.
Docs: https://docs.opentrons.com/python-api/liquid-classes/
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex liquid classes — water / ethanol_80 / glycerol_50",
    "author": "Opentrons-Lab-Agent template",
    "description": "Demonstrates get_liquid_class + transfer_with_liquid_class for three verified classes.",
}

# Use the highest apiLevel your Opentrons install supports (liquid classes: 2.24+).
requirements = {"robotType": "Flex", "apiLevel": "2.27"}


def finish_tip(pipette, trash, dry_run_on: bool) -> None:
    """Return tips during a liquid-free dry run; discard them otherwise."""
    if dry_run_on:
        pipette.return_tip()
    else:
        pipette.drop_tip(trash)


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_bool(
        display_name="Dry run: return tips",
        variable_name="dry_run_on",
        default=False,
    )


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tiprack = protocol.load_labware("opentrons_flex_96_tiprack_50ul", "D3")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C3")
    plate = protocol.load_labware("nest_96_wellplate_200ul_flat", "C2")

    pipette = protocol.load_instrument(
        "flex_1channel_50",
        "left",
        tip_racks=[tiprack],
    )
    dry_run_on = protocol.params.dry_run_on
    if dry_run_on:
        protocol.comment("DRY RUN: no liquids may be loaded; tips will return to their pickup wells.")

    lc_water = protocol.get_liquid_class(name="water")
    lc_etoh = protocol.get_liquid_class(name="ethanol_80")
    lc_gly = protocol.get_liquid_class(name="glycerol_50")

    # Small transfers — adjust wells/volumes to your assay.
    for liquid_class, src_well, dest_well in (
        (lc_water, reservoir["A1"], plate["A1"]),
        (lc_etoh, reservoir["A2"], plate["A2"]),
        (lc_gly, reservoir["A3"], plate["A3"]),
    ):
        pipette.pick_up_tip()
        pipette.transfer_with_liquid_class(
            liquid_class=liquid_class,
            volume=20,
            source=src_well,
            dest=dest_well,
            new_tip="never",
        )
        finish_tip(pipette, trash, dry_run_on)

    # One-to-many with liquid class: loop per destination.
    # Do NOT pass a list as dest with a single source — that raises ValueError.
    # There is no distribute_with_liquid_class API.
    for well in plate.wells()[:8]:
        pipette.pick_up_tip()
        pipette.transfer_with_liquid_class(
            liquid_class=lc_water,
            volume=10,
            source=reservoir["A1"],
            dest=well,
            new_tip="never",
        )
        finish_tip(pipette, trash, dry_run_on)
