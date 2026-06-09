"""Example: Flex serial dilution along row A.

See README.md in this folder. Based on bundled-library/l0-flex-templates/flex_template_serial_dilution.py
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex — serial dilution (row) example",
    "author": "LabscriptAI OT example",
    "description": "Row A: A1 stock, A2 primed, serial transfer along A — 7 steps, 50 µL.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_int(
        display_name="Number of dilution steps",
        variable_name="dilution_steps",
        default=7,
        minimum=1,
        maximum=11,
    )
    parameters.add_float(
        display_name="Step transfer volume (µL)",
        variable_name="transfer_volume_ul",
        default=50.0,
        minimum=5.0,
        maximum=50.0,
    )


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tiprack = protocol.load_labware("opentrons_flex_96_tiprack_50ul", "D3")

    diluent = protocol.load_labware("nest_12_reservoir_15ml", "B3")
    plate = protocol.load_labware("nest_96_wellplate_200ul_flat", "C3")

    pipette = protocol.load_instrument(
        "flex_1channel_50",
        "left",
        tip_racks=[tiprack],
    )

    steps = protocol.params.dilution_steps
    xfer = protocol.params.transfer_volume_ul

    row = "A"
    wells = [f"{row}{i}" for i in range(1, 2 + steps)]

    prime_vol = min(pipette.max_volume, xfer * 2)
    pipette.pick_up_tip()
    pipette.aspirate(prime_vol, diluent["A1"])
    pipette.dispense(prime_vol, plate[wells[1]])
    pipette.drop_tip(trash)

    for i in range(steps):
        src = plate[wells[i]]
        dst = plate[wells[i + 1]]
        pipette.pick_up_tip()
        pipette.aspirate(xfer, src)
        pipette.dispense(xfer, dst)
        pipette.mix(repetitions=8, volume=min(40, xfer * 0.8), location=dst)
        pipette.drop_tip(trash)
