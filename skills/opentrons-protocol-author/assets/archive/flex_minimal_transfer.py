from opentrons import protocol_api

metadata = {
    "protocolName": "Flex Minimal Transfer Reference",
    "author": "Opentrons-Lab-Agent",
    "description": "Small Flex reference protocol for local analyze/simulate loops before live execution.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.22"}


def finish_tip(pipette, trash, dry_run_on: bool) -> None:
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
    tip_rack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "C2")
    source = protocol.load_labware("nest_12_reservoir_15ml", "D2")
    destination = protocol.load_labware("nest_96_wellplate_200ul_flat", "D1")
    pipette = protocol.load_instrument("flex_1channel_1000", "left", [tip_rack])
    dry_run_on = protocol.params.dry_run_on

    pipette.pick_up_tip()
    pipette.aspirate(100, source["A1"])
    pipette.dispense(100, destination["A1"])
    finish_tip(pipette, trash, dry_run_on)

    protocol.comment("flex minimal transfer reference complete")
