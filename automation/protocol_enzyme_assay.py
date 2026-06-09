"""BioSyn Flex enzyme assay — PlsC substrate matrix + 4-enzyme cascade (Video 1).

Deck: C1 source (4C), D1 reaction (Heater-Shaker 37C), C2 reservoir, A2/B2 tip racks.
Labware: nest_96_wellplate_100ul_pcr_full_skirt on source + reaction (HS uses PCR adapter).
"""

from __future__ import annotations

from opentrons import protocol_api

metadata = {
    "protocolName": "BioSyn — enzyme assay (PlsC + cascade)",
    "author": "LabscriptAI OT",
    "description": "PlsC matrix cols 1-6 + cascade cols 7-8 on one 96-well plate.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}

# --- Maps (filled per biosyn-flex-automation-plan.md) ---

DECK_MAP = {
    "trash": "A3",
    "tiprack_1ch": "A2",
    "tiprack_8ch": "B2",
    "reservoir": "C2",
    "temp_module": "C1",
    "heater_shaker": "D1",
}

SOURCE_MAP = {
    "plsC_enzymes": ["A1", "A2", "A3", "A4", "A5", "A6"],
    "plsC_substrates": {"GGGP": "B1", "C18:1-CoA": "B2", "iso-C15:0-CoA": "B3"},
    "cascade_enzymes": {"FadD": "C1", "GGGPS": "C2", "PlsC": "C3", "CarS": "C4"},
    "cascade_substrates": {"G3P": "D1", "G1P": "D2"},
    "diluent": "D4",
}

PLSC_ROWS = list("ABCDEF")
PLSC_COLS = list(range(1, 7))
CASCADE_ROWS = list("ABCDEFGH")
CASCADE_COLS = [7, 8]

PLSC_SUBSTRATE_BY_ROW = {
    "A": "B1",
    "B": "B1",
    "C": "B2",
    "D": "B2",
    "E": "B3",
    "F": "B3",
}

PLSC_ENZYME_BY_COL = {
    1: "A1",
    2: "A2",
    3: "A3",
    4: "A4",
    5: "A5",
    6: None,  # no enzyme — diluent top-up
}

CASCADE_CONDITIONS = {
    "A": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D1"},
    "B": {"enzymes": ["C2", "C3", "C4"], "substrate": "D1"},
    "C": {"enzymes": ["C1", "C3", "C4"], "substrate": "D1"},
    "D": {"enzymes": ["C1", "C2", "C4"], "substrate": "D1"},
    "E": {"enzymes": ["C1", "C2", "C3"], "substrate": "D1"},
    "F": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D2"},
    "G": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D1"},
    "H": {"enzymes": [], "substrate": "D1"},
}

ALL_CASCADE_ENZYMES = ["C1", "C2", "C3", "C4"]

PCR_PLATE = "nest_96_wellplate_100ul_pcr_full_skirt"
TEMP_ADAPTER = "opentrons_96_well_aluminum_block"
HS_PCR_ADAPTER = "opentrons_96_pcr_adapter"

VOLUME_MAP = {
    "buffer_ul": 120.0,
    "substrate_ul": 40.0,
    "enzyme_ul": 20.0,
    "diluent_ul": 20.0,
}


def add_parameters(parameters: protocol_api.ParameterContext) -> None:
    parameters.add_bool(
        display_name="Dry run (short hold)",
        variable_name="dry_run",
        default=True,
    )
    parameters.add_int(
        display_name="Incubation (dry, sec)",
        variable_name="incubation_seconds",
        default=90,
        minimum=30,
        maximum=600,
    )
    parameters.add_int(
        display_name="Incubation (real, min)",
        variable_name="incubation_minutes",
        default=45,
        minimum=5,
        maximum=120,
    )


def _well(row: str, col: int) -> str:
    return f"{row}{col}"


def _transfer_1ch(
    pipette: protocol_api.InstrumentContext,
    volume: float,
    source_plate: protocol_api.Labware,
    source_well: str,
    dest_plate: protocol_api.Labware,
    dest_wells: list[str],
) -> None:
    """One tip, same source -> one or more destination wells; tip returned to rack."""
    pipette.pick_up_tip()
    for dest_well in dest_wells:
        pipette.aspirate(volume, source_plate[source_well])
        pipette.dispense(volume, dest_plate[dest_well])
    pipette.return_tip()


def run(protocol: protocol_api.ProtocolContext) -> None:
    dry_run = protocol.params.dry_run
    vol = VOLUME_MAP

    protocol.load_trash_bin(DECK_MAP["trash"])
    tiprack_1 = protocol.load_labware(
        "opentrons_flex_96_tiprack_1000ul", DECK_MAP["tiprack_1ch"]
    )
    tiprack_8 = protocol.load_labware(
        "opentrons_flex_96_tiprack_1000ul", DECK_MAP["tiprack_8ch"]
    )
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", DECK_MAP["reservoir"])

    temp_mod = protocol.load_module("temperatureModuleV2", DECK_MAP["temp_module"])
    if not dry_run:
        temp_mod.set_temperature(4)
    source = temp_mod.load_labware(PCR_PLATE, adapter=TEMP_ADAPTER)

    hs_mod = protocol.load_module("heaterShakerModuleV1", DECK_MAP["heater_shaker"])
    hs_mod.close_labware_latch()
    reaction = hs_mod.load_labware(
        PCR_PLATE,
        adapter=HS_PCR_ADAPTER,
    )

    p1 = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tiprack_1])
    p8 = protocol.load_instrument("flex_8channel_1000", "right", tip_racks=[tiprack_8])

    protocol.comment("=== Phase A: common buffer to all reaction wells ===")

    for col_idx in range(8):
        p8.transfer(
            vol["buffer_ul"],
            reservoir["A1"],
            reaction.columns()[col_idx],
            new_tip="always",
            trash=False,
        )

    protocol.comment("=== Phase B: PlsC matrix (cols 1-6) ===")

    for row in PLSC_ROWS:
        substrate_src = PLSC_SUBSTRATE_BY_ROW[row]
        dests = [_well(row, col) for col in PLSC_COLS]
        _transfer_1ch(
            p1, vol["substrate_ul"], source, substrate_src, reaction, dests
        )

    for col in PLSC_COLS:
        enzyme_src = PLSC_ENZYME_BY_COL[col]
        dests = [_well(row, col) for row in PLSC_ROWS]
        if enzyme_src is None:
            _transfer_1ch(
                p1, vol["diluent_ul"], source, SOURCE_MAP["diluent"], reaction, dests
            )
        else:
            _transfer_1ch(
                p1, vol["enzyme_ul"], source, enzyme_src, reaction, dests
            )

    protocol.comment("=== Phase C: cascade matrix (cols 7-8) ===")

    for row in CASCADE_ROWS:
        condition = CASCADE_CONDITIONS[row]
        substrate_src = condition["substrate"]
        active_enzymes = condition["enzymes"]

        dests = [_well(row, col) for col in CASCADE_COLS]
        _transfer_1ch(
            p1, vol["substrate_ul"], source, substrate_src, reaction, dests
        )

        for enzyme_well in active_enzymes:
            _transfer_1ch(
                p1, vol["enzyme_ul"], source, enzyme_well, reaction, dests
            )

        for enzyme_well in ALL_CASCADE_ENZYMES:
            if enzyme_well not in active_enzymes:
                _transfer_1ch(
                    p1,
                    vol["diluent_ul"],
                    source,
                    SOURCE_MAP["diluent"],
                    reaction,
                    dests,
                )

    protocol.comment("=== Phase D: 37C incubation on Heater-Shaker ===")

    hs_mod.close_labware_latch()
    hs_mod.set_and_wait_for_temperature(37)
    hs_mod.set_and_wait_for_shake_speed(500)

    if dry_run:
        protocol.delay(
            seconds=protocol.params.incubation_seconds,
            msg="Dry-run incubation — replace with real timing for production",
        )
    else:
        protocol.delay(
            minutes=protocol.params.incubation_minutes,
            msg="Enzyme reaction incubation at 37C",
        )

    hs_mod.deactivate_shaker()
    hs_mod.deactivate_heater()
    hs_mod.open_labware_latch()

    protocol.pause(
        msg="Enzyme reactions complete. Quench and LC-MS are manual downstream steps."
    )
