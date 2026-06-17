"""BioSyn enzyme assay on Opentrons Flex.

Left half (cols 1-6): PlsC enzyme x substrate matrix (36 wells).
Right half (cols 7-8): FadD-GGGPS-PlsC-CarS cascade matrix (16 wells).

Dry-run uses water; volumes sized for flex_1channel_1000 / flex_8channel_1000.
Deck: C1 source (4C), D1 reaction (37C heater-shaker), C2 reservoir.

Labware matches prior BioSyn enzyme runs on this Flex (reuse stored calibration):
  C1: nest_96_wellplate_100ul_pcr_full_skirt + opentrons_96_well_aluminum_block
  D1: nest_96_wellplate_100ul_pcr_full_skirt + opentrons_96_pcr_adapter
"""

from __future__ import annotations

from opentrons import protocol_api

metadata = {
    "protocolName": "BioSyn Enzyme Assay - PlsC Matrix + Cascade",
    "author": "BioSyn Automation",
    "description": (
        "Water-based dry run for PlsC acyltransferase matrix and four-enzyme "
        "cascade validation. C1 source plate, D1 reaction plate, C2 reservoir."
    ),
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}

# --- Dry-run parameters (increase volumes for visible pipetting on 1000 uL pipettes) ---
DRY_RUN = True
DROP_TIPS_IN_TRASH = not DRY_RUN  # dry-run: return tips to rack; real run: trash
BUFFER_VOL = 120.0
SUBSTRATE_VOL = 40.0
ENZYME_VOL = 25.0
DILUENT_VOL = 25.0
INCUBATION_SEC = 90 if DRY_RUN else 3600

# Prior run labware offsets on Silabrobot001 — attach at run create via API
CALIBRATED_LABWARE = {
    "source_plate": "opentrons/nest_96_wellplate_100ul_pcr_full_skirt/3",
    "source_adapter": "opentrons/opentrons_96_well_aluminum_block/1",
    "reaction_plate": "opentrons/nest_96_wellplate_100ul_pcr_full_skirt/3",
    "reaction_adapter": "opentrons/opentrons_96_pcr_adapter/1",
    "reservoir": "opentrons/nest_12_reservoir_15ml/2",
    "tiprack": "opentrons/opentrons_flex_96_tiprack_1000ul/1",
}

PLSC_ROWS = ["A", "B", "C", "D", "E", "F"]
PLSC_COLS = [str(i) for i in range(1, 7)]
PLSC_ENZYME_WELLS = ["A1", "A2", "A3", "A4", "A5"]  # col 1-5 enzymes; col 6 = diluent
PLSC_SUBSTRATE_BY_ROW = {
    "A": "B1",
    "B": "B1",  # GGGP rep 1/2
    "C": "B2",
    "D": "B2",  # C18:1-CoA
    "E": "B3",
    "F": "B3",  # iso-C15:0-CoA
}

# Cascade: rows A-H x cols 7-8; source well keys on C1 plate
CASCADE_CONDITIONS: dict[str, dict[str, list[str] | str]] = {
    "A": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D1"},  # full G3P
    "B": {"enzymes": ["C2", "C3", "C4"], "substrate": "D1"},  # no FadD
    "C": {"enzymes": ["C1", "C3", "C4"], "substrate": "D1"},  # no GGGPS
    "D": {"enzymes": ["C1", "C2", "C4"], "substrate": "D1"},  # no PlsC
    "E": {"enzymes": ["C1", "C2", "C3"], "substrate": "D1"},  # no CarS
    "F": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D2"},  # G1P
    "G": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D1"},  # G3P explicit
    "H": {"enzymes": [], "substrate": "D1"},  # no enzyme
}
CASCADE_ROWS = list(CASCADE_CONDITIONS.keys())
CASCADE_COLS = ["7", "8"]
DILUENT_WELL = "D4"


def _well(plate: protocol_api.Labware, row: str, col: str) -> protocol_api.Well:
    return plate[f"{row}{col}"]


def _release_tip(pipette: protocol_api.InstrumentContext) -> None:
    if DROP_TIPS_IN_TRASH:
        pipette.drop_tip()
    else:
        pipette.return_tip()


def run(protocol: protocol_api.ProtocolContext) -> None:
    protocol.load_trash_bin("A3")

    # --- Modules (deck: C1, D1; A1/B1 thermocycler unused in enzyme assay) ---
    temp_mod = protocol.load_module("temperatureModuleV2", "C1")
    hs_mod = protocol.load_module("heaterShakerModuleV1", "D1")

    source = temp_mod.load_labware(
        "nest_96_wellplate_100ul_pcr_full_skirt",
        adapter="opentrons_96_well_aluminum_block",
    )
    reaction = hs_mod.load_labware(
        "nest_96_wellplate_100ul_pcr_full_skirt",
        adapter="opentrons_96_pcr_adapter",
    )
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "C2")
    tips_1 = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "A2")
    tips_1_b = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B3")
    tips_8 = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B2")

    # --- Pipettes ---
    p1000 = protocol.load_instrument(
        "flex_1channel_1000", "left", tip_racks=[tips_1, tips_1_b]
    )
    p1000_multi = protocol.load_instrument("flex_8channel_1000", "right", tip_racks=[tips_8])

    buffer = reservoir["A1"]

    temp_mod.set_temperature(4)
    hs_mod.close_labware_latch()

    # --- Phase A: common buffer to all target wells ---
    plsc_dests = [_well(reaction, r, c) for r in PLSC_ROWS for c in PLSC_COLS]
    cascade_dests = [_well(reaction, r, c) for r in CASCADE_ROWS for c in CASCADE_COLS]
    all_dests = plsc_dests + cascade_dests

    # 8-channel: full columns 1-8 (each column is a complete vertical strip)
    for col in range(1, 9):
        col_wells = reaction.columns()[col - 1]
        if not any(w in all_dests for w in col_wells):
            continue
        p1000_multi.pick_up_tip()
        p1000_multi.aspirate(BUFFER_VOL, buffer)
        p1000_multi.dispense(BUFFER_VOL, col_wells[0])
        _release_tip(p1000_multi)

    # --- Phase B: PlsC matrix — substrate then enzyme (enzyme last = reaction start) ---
    for row in PLSC_ROWS:
        sub_well = source[PLSC_SUBSTRATE_BY_ROW[row]]
        for col in PLSC_COLS:
            dest = _well(reaction, row, col)
            p1000.transfer(
                SUBSTRATE_VOL, sub_well, dest, new_tip="always", trash=DROP_TIPS_IN_TRASH
            )

    for col_idx, enz_well_name in enumerate(PLSC_ENZYME_WELLS, start=1):
        enz_well = source[enz_well_name]
        col = str(col_idx)
        for row in PLSC_ROWS:
            dest = _well(reaction, row, col)
            p1000.transfer(
                ENZYME_VOL, enz_well, dest, new_tip="always", trash=DROP_TIPS_IN_TRASH
            )

    for row in PLSC_ROWS:
        dest = _well(reaction, row, "6")
        p1000.transfer(
            DILUENT_VOL, source[DILUENT_WELL], dest, new_tip="always", trash=DROP_TIPS_IN_TRASH
        )

    # --- Phase C: Cascade matrix ---
    for row in CASCADE_ROWS:
        cond = CASCADE_CONDITIONS[row]
        sub_well = source[str(cond["substrate"])]
        enzymes: list[str] = list(cond["enzymes"])  # type: ignore[arg-type]
        for col in CASCADE_COLS:
            dest = _well(reaction, row, col)
            p1000.transfer(
                SUBSTRATE_VOL, sub_well, dest, new_tip="always", trash=DROP_TIPS_IN_TRASH
            )
            for enz_key in enzymes:
                p1000.transfer(
                    ENZYME_VOL, source[enz_key], dest, new_tip="always", trash=DROP_TIPS_IN_TRASH
                )
            missing = 4 - len(enzymes)
            if missing > 0:
                p1000.transfer(
                    DILUENT_VOL * missing,
                    source[DILUENT_WELL],
                    dest,
                    new_tip="always",
                    trash=DROP_TIPS_IN_TRASH,
                )

    # --- Phase D: incubate on D1 heater-shaker ---
    hs_mod.set_target_temperature(37)
    hs_mod.wait_for_temperature()
    hs_mod.set_and_wait_for_shake_speed(500)
    protocol.delay(seconds=INCUBATION_SEC)
    hs_mod.deactivate_shaker()
    hs_mod.deactivate_heater()
    hs_mod.open_labware_latch()

    protocol.pause(
        "Enzyme assay setup complete. Quench and LC-MS sample prep are manual downstream steps."
    )
