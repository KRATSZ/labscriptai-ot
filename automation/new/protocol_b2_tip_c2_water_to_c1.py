"""Flex protocol — pick 1000 uL tip from B2, transfer 50 uL water from C2 reservoir to D2 plate.

Deck:
  B2  opentrons_flex_96_tiprack_1000ul   (1000 uL tip rack)
  C2  nest_12_reservoir_15ml             (water source, well A1)
  D2  nest_96_wellplate_200ul_flat       (destination, well A1)
  A3  trash bin

Notes:
  - Transfer volume is 50 uL on a 1000 uL pipette (below the 10% recommended
    min of 100 uL). Accuracy is acceptable for a teaching/demo transfer; for
    precision-critical work switch to flex_1channel_50 + 50 uL tip rack.
  - Uses the Opentrons-verified `water` liquid class.
  - Optional capacitive liquid probe (LPD) on source well A1 before transfer.
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "B2 tip -> C2 water -> D2 plate (50 uL)",
    "author": "Opentrons-Lab-Agent",
    "description": "Pick 1000 uL tip from B2, aspirate 50 uL water from C2 reservoir, dispense into D2 plate.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_bool(
        display_name="Use liquid probe",
        variable_name="use_liquid_probe",
        default=False,
    )


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tip_rack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B2")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C2")
    plate = protocol.load_labware("nest_96_wellplate_200ul_flat", "D2")

    use_liquid_probe = protocol.params.use_liquid_probe

    pipette = protocol.load_instrument(
        "flex_1channel_1000",
        "left",
        tip_racks=[tip_rack],
        liquid_presence_detection=use_liquid_probe,
    )

    water = protocol.get_liquid_class(name="water")
    source = reservoir["A1"]

    pipette.pick_up_tip()
    if use_liquid_probe:
        pipette.require_liquid_presence(source)
        protocol.comment("LPD: source A1 liquid present")

    pipette.transfer_with_liquid_class(
        liquid_class=water,
        volume=50,
        source=source,
        dest=plate["A1"],
        new_tip="never",
        trash_location=trash,
    )
    pipette.drop_tip(trash)
