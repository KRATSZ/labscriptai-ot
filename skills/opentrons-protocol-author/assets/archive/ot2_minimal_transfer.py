from opentrons import protocol_api

metadata = {
    "protocolName": "OT-2 Minimal Transfer Reference",
    "author": "Opentrons-Lab-Agent",
    "description": "Small OT-2 reference protocol for Codex and Claude Code author/verify loops.",
}

requirements = {"robotType": "OT-2", "apiLevel": "2.16"}


def finish_tip(pipette, dry_run_on: bool) -> None:
    if dry_run_on:
        pipette.return_tip()
    else:
        pipette.drop_tip()


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_bool(
        display_name="Dry run: return tips",
        variable_name="dry_run_on",
        default=False,
    )


def run(protocol: protocol_api.ProtocolContext) -> None:
    tip_rack = protocol.load_labware("opentrons_96_tiprack_300ul", 1)
    source = protocol.load_labware("nest_12_reservoir_15ml", 2)
    destination = protocol.load_labware("nest_96_wellplate_200ul_flat", 3)
    pipette = protocol.load_instrument("p300_single_gen2", "left", [tip_rack])
    dry_run_on = protocol.params.dry_run_on

    pipette.pick_up_tip()
    pipette.aspirate(60, source["A1"])
    pipette.dispense(60, destination["A1"])
    finish_tip(pipette, dry_run_on)

    protocol.comment("ot2 minimal transfer reference complete")
