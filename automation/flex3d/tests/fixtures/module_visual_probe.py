"""Simulation-only visual regression fixture; no experimental SOP."""
requirements = {'robotType': 'Flex', 'apiLevel': '2.25'}
metadata = {'protocolName': 'Flex module visual regression'}


def run(ctx):
    tc = ctx.load_module('thermocycler module gen2', 'B1')
    hs = ctx.load_module('heaterShakerModuleV1', 'D1')
    temp = ctx.load_module('temperature module gen2', 'C3')
    ctx.load_module('magneticBlockV1', 'D2')
    reader = ctx.load_module('absorbanceReaderV1', 'D3')
    tips = ctx.load_labware('opentrons_flex_96_tiprack_200ul', 'C2')
    plate = tc.load_labware('nest_96_wellplate_100ul_pcr_full_skirt')
    water = ctx.define_liquid('Visual test water', 'Synthetic simulation fixture', '#3b98d4')
    plate['A1'].load_liquid(water, 10)
    pipette = ctx.load_instrument('flex_1channel_1000', 'right', tip_racks=[tips])
    hs.open_labware_latch()
    hs.close_labware_latch()
    tc.open_lid()
    pipette.pick_up_tip()
    pipette.aspirate(10, plate['A1'].bottom(1))
    pipette.dispense(10, plate['A2'].bottom(1))
    pipette.return_tip()
    tc.close_lid()
    tc.open_lid()
    temp.set_temperature(4)
    temp.deactivate()
    reader.open_lid()
    reader.close_lid()
