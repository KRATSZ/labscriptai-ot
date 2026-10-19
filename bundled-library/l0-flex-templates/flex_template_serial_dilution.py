"""Template: serial dilution along row A (A1 = stock / high concentration, A2+ = dilution chain).

A1 holds twice the transfer volume of stock. Every destination A2 onward is
primed with one transfer volume of buffer. Each transfer and mix halves concentration.

Adjust diluent volume, transfer volume, and number of steps to match your SOP.
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "Flex — serial dilution (row) template",
    "author": "Replace",
    "description": "Row A: A1 stock, A2 onward primed, serial transfer along A — parameterize counts.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def finish_tip(pipette, trash, dry_run_on: bool) -> None:
    """Return tips during a liquid-free dry run; discard them otherwise."""
    if dry_run_on:
        pipette.return_tip()
    else:
        pipette.drop_tip(trash)


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
    parameters.add_bool(
        display_name="Dry run: return tips",
        variable_name="dry_run_on",
        default=False,
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
    dry_run_on = protocol.params.dry_run_on
    if dry_run_on:
        protocol.comment("DRY RUN: no liquids may be loaded; tips will return to their pickup wells.")

    row = "A"
    wells = [f"{row}{i}" for i in range(1, 2 + steps)]

    if not dry_run_on:
        stock = protocol.define_liquid(name="Stock", description="Starting sample", display_color="#ee5555")
        buffer = protocol.define_liquid(name="Diluent", description="Dilution buffer", display_color="#55aaff")
        plate["A1"].load_liquid(liquid=stock, volume=2 * xfer)
        diluent["A1"].load_liquid(liquid=buffer, volume=2000)

    # Equal buffer and transferred sample volumes give a two-fold dilution at every step.
    for well in wells[1:]:
        pipette.pick_up_tip()
        pipette.aspirate(xfer, diluent["A1"])
        pipette.dispense(xfer, plate[well])
        finish_tip(pipette, trash, dry_run_on)

    for i in range(steps):
        src = plate[wells[i]]
        dst = plate[wells[i + 1]]
        pipette.pick_up_tip()
        pipette.aspirate(xfer, src)
        pipette.dispense(xfer, dst)
        pipette.mix(repetitions=8, volume=min(40, xfer * 0.8), location=dst)
        finish_tip(pipette, trash, dry_run_on)
