from opentrons import protocol_api

metadata = {
    "protocolName": "Harness Syntax Error",
    "author": "harness",
    "description": "Deliberate Python syntax error (unclosed call) to exercise the simulate-repair loop.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.22"}


def run(protocol: protocol_api.ProtocolContext) -> None:
    tiprack = protocol.load_labware("opentrons_flex_96_tiprack_1000uL", "A1"
    plate = protocol.load_labware("nest_96_wellplate_200ul_pcr_full_skirt", "B1")
    pipette = protocol.load_instrument("flex_8channel_1000", mount="left", tip_racks=[tiprack])
    pipette.pick_up_tip()
    pipette.aspirate(50, plate["A1"])
    pipette.dispense(50, plate["B1"])
    pipette.drop_tip()
