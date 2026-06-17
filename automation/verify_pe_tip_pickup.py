"""Dry-run helper: pick up PE custom tip racks on A2 (50 µL) and B2 (200 µL).

Pick up from column 1 (A1), pause for visual check, then move tips away from the
front column. Single-channel places in H12; 8-channel uses A12 so all 8 tips
land in column 12 (A12–H12). Not discarded in trash.
Place labware JSON under automation/labware/. Measure rack height in
pe_tiprack_config.json and run build_pe_tipracks.py before live tests.
"""

from opentrons import protocol_api

metadata = {
    "protocolName": "PE tip verify v4 (includes labware)",
    "author": "LabscriptAI OT",
    "description": "Pick A1, pause, single→H12; 8ch column 1→column 12 via A12.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.24"}

PE_TIP_NAMESPACE = "custom_beta"
PE_TIP_VERSION = 1
TIPRACK_50UL = "pe_50a_1_ts_96_tiprack_50ul"
TIPRACK_200UL = "pe_200a_1_ts_96_tiprack_200ul"
PICK_WELL = "A1"
# 8-channel aligns by column; A12 anchors column 12 (A12–H12), not H12.
RETURN_WELL_50 = "H12"
RETURN_WELL_200 = "A12"


def run(protocol: protocol_api.ProtocolContext) -> None:
    tips_50 = protocol.load_labware(
        TIPRACK_50UL, "A2", namespace=PE_TIP_NAMESPACE, version=PE_TIP_VERSION
    )
    tips_200 = protocol.load_labware(
        TIPRACK_200UL, "B2", namespace=PE_TIP_NAMESPACE, version=PE_TIP_VERSION
    )

    p1 = protocol.load_instrument(
        "flex_1channel_1000", "left", tip_racks=[tips_50]
    )
    p8 = protocol.load_instrument(
        "flex_8channel_1000", "right", tip_racks=[tips_200]
    )

    p1.pick_up_tip(tips_50[PICK_WELL])
    protocol.pause("Check 50 µL tip on left pipette — sealed and straight?")
    p1.drop_tip(tips_50[RETURN_WELL_50])

    p8.pick_up_tip(tips_200[PICK_WELL])
    protocol.pause("Check 200 µL tips on 8-channel — all 8 sealed?")
    p8.drop_tip(tips_200[RETURN_WELL_200])
