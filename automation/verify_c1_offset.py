"""One-step C1 offset check — pick tip, aspirate source A1, pause for visual check."""

from opentrons import protocol_api

metadata = {
    "protocolName": "Verify C1 200ul flat offset",
    "author": "LabscriptAI OT",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def run(protocol: protocol_api.ProtocolContext) -> None:
    protocol.load_trash_bin("A3")
    tips = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "A2")
    temp_mod = protocol.load_module("temperatureModuleV2", "C1")
    source = temp_mod.load_labware("nest_96_wellplate_200ul_flat")
    pipette = protocol.load_instrument(
        "flex_1channel_1000", "left", tip_racks=[tips]
    )

    pipette.pick_up_tip()
    pipette.aspirate(10, source["A1"])
    protocol.pause(
        "C1 A1 aspirate done — check tip depth. Stop run if too deep/shallow."
    )
    pipette.return_tip()
