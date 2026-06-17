"""Flex gradient dilution along row A (2-fold serial dilution).

A1 = stock (highest concentration). A2 is primed with diluent (2× transfer volume).
Each subsequent step transfers xfer µL from well i to well i+1 and mixes,
producing a geometric concentration gradient: 100%, 50%, 25%, 12.5%, …

Adjust dilution_steps and transfer_volume_ul via runtime parameters.
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex — gradient dilution (2-fold, row A)",
    "author": "LabscriptAI OT",
    "description": "Row A: A1 stock, A2 primed, serial 2-fold gradient — 7 steps, 50 µL.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_int(
        display_name="Number of gradient steps",
        variable_name="dilution_steps",
        default=7,
        minimum=1,
        maximum=11,
    )
    parameters.add_float(
        display_name="Step transfer volume (uL)",
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

    # Prime A2 with buffer (2× xfer) so first serial step A1→A2 yields 2-fold dilution.
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
