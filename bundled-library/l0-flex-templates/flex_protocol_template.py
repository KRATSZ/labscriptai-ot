from opentrons import protocol_api

metadata = {
    "protocolName": "Flex template — replace me",
    "author": "Replace me",
    "description": "Replace me",
}

# Flex: use flex_* pipette names, load_trash_bin, and Flex tip racks.
# Default apiLevel 2.24+ (liquid-class compatible). Raise toward MAX_SUPPORTED_VERSION if needed.
requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def finish_tip(pipette, trash, dry_run_on: bool) -> None:
    """Return tips during a liquid-free dry run; discard them otherwise."""
    if dry_run_on:
        pipette.return_tip()
    else:
        pipette.drop_tip(trash)


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    """Add runtime parameters when the protocol needs per-run inputs.

    Every display_name must be <= 30 characters (Opentrons hard limit).
    """
    parameters.add_bool(
        display_name="Dry run: return tips",
        variable_name="dry_run_on",
        default=False,
    )
    # Example — uncomment and tune; keep display_name short:
    # parameters.add_int(
    #     display_name="Sample count",
    #     variable_name="sample_count",
    #     default=8,
    #     minimum=1,
    #     maximum=96,
    # )
    return None


def run(protocol: protocol_api.ProtocolContext) -> None:
    """Adjust slots and labware to match the physical deck before running."""

    trash = protocol.load_trash_bin("A3")
    tip_rack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "C2")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "B3")
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", "C3")

    pipette = protocol.load_instrument("flex_1channel_1000", "left", [tip_rack])
    dry_run_on = protocol.params.dry_run_on
    if dry_run_on:
        protocol.comment("DRY RUN: no liquids may be loaded; tips will return to their pickup wells.")

    pipette.pick_up_tip()
    pipette.aspirate(50, reservoir["A1"])
    pipette.dispense(50, plate["A1"])
    finish_tip(pipette, trash, dry_run_on)

    # protocol.capture_image(filename="after-first-dispense")
