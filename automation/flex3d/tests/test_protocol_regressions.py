"""Offline regressions for liquid balance, waste chutes, modules and portable assets."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import mujoco

from sim.flex_protocol import load_analysis, plan, scene_spec
from sim.flex_scene import load_deck, load_model, write_model
from sim.play_protocol import Scene, check_clearance, check_targets

ROOT = Path(__file__).resolve().parents[3]


class ProtocolRegressions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.deck = load_deck()

    def analyze(self, source, parameters=None):
        output = self.folder / 'analysis.json'
        args = [sys.executable, '-m', 'opentrons.cli', 'analyze', '--check', '--json-output', str(output)]
        if parameters:
            args += ['--rtp-values', json.dumps(parameters)]
        done = subprocess.run([*args, str(source)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return load_analysis(output, self.deck)

    def scene(self, run, folder):
        planned = plan(run)
        model = load_model(write_model(self.deck, scene_spec(planned), folder))
        return planned, Scene(planned, model, mujoco.MjData(model))

    def test_noop_does_not_check_an_unmeasured_parked_pose_as_a_motion_path(self):
        run = self.analyze(ROOT / 'servers/opentrons-mcp/test/fixtures/harness/protocol_valid_flex.py')
        planned, scene = self.scene(run, self.folder / 'noop')
        self.assertEqual(check_clearance(planned, scene)[2], 0)

    def test_serial_templates_preserve_volume_and_twofold_concentration(self):
        sources = ['examples/01-flex-serial-dilution/protocol.py',
                   'examples/02-flex-gradient-dilution/protocol.py',
                   'skills/opentrons-protocol-author/assets/flex_template_serial_dilution.py',
                   'bundled-library/l0-flex-templates/flex_template_serial_dilution.py']
        for source in sources:
            for volume, steps in [(50, 7), (5, 11)]:
                with self.subTest(source=source, volume=volume):
                    run = self.analyze(ROOT / source, {'transfer_volume_ul': volume, 'dilution_steps': steps})
                    planned = plan(run)
                    self.assertFalse(planned.warnings)
                    plate = next(lw for lw in run.labware.values() if lw.slot == 'C3')
                    stock = next(key for key, liquid in run.liquids.items() if liquid.name == 'Stock')
                    wells = planned.keys[-1].state.wells
                    for index in range(steps + 1):
                        mix = wells[(plate.key, f'A{index + 1}')]
                        total = sum(mix.values())
                        self.assertAlmostEqual(total, volume * (2 if index == steps else 1))
                        self.assertAlmostEqual(mix.get(stock, 0) / total, 2 ** -index)
                    self.assertAlmostEqual(sum(sum(mix.values()) for mix in wells.values()), 2000 + 2 * volume)

    def test_multichannel_waste_chute_and_basic_model_fallback(self):
        source = self.folder / 'chute.py'
        source.write_text('''from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    chute = p.load_waste_chute()
    rack = p.load_labware("opentrons_flex_96_tiprack_50ul", "A3")
    reservoir = p.load_labware("nest_12_reservoir_15ml", "B3")
    plate = p.load_labware("nest_96_wellplate_200ul_flat", "C3")
    liquid = p.define_liquid(name="Water", description="Water", display_color="#55aaff")
    reservoir["A1"].load_liquid(liquid=liquid, volume=2000)
    pip = p.load_instrument("flex_8channel_50", "left", tip_racks=[rack])
    pip.pick_up_tip()
    pip.aspirate(10, reservoir["A1"])
    pip.dispense(10, plate["A1"])
    pip.drop_tip(chute)
''')
        run = self.analyze(source)
        self.assertTrue(run.chutes)
        self.assertIsNotNone(run.chute)
        planned, scene = self.scene(run, self.folder / 'chute-model')
        self.assertFalse(planned.warnings)
        check_targets(planned, scene)
        check_clearance(planned, scene)
        plate = next(lw for lw in run.labware.values() if lw.slot == 'C3')
        for row in 'ABCDEFGH':
            self.assertAlmostEqual(sum(planned.keys[-1].state.wells[(plate.key, f'{row}1')].values()), 10)
        # A chute wall moved into the gantry path must be an actual obstacle.
        wall = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_GEOM, 'waste_chute_wall_front')
        carriage = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_GEOM, 'carriage_block')
        scene.at(0)
        scene.model.geom_pos[wall] = scene.data.geom_xpos[carriage]
        scene.model.geom_size[wall] = [.05, .05, .05]
        with self.assertRaisesRegex(RuntimeError, 'waste_chute'):
            check_clearance(planned, scene)

    def test_modules_and_stacked_adapter_keep_official_target_geometry(self):
        source = self.folder / 'modules.py'
        source.write_text('''from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    tc = p.load_module("thermocyclerModuleV2", "B1")
    tc.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt")
    tc.open_lid()
    tc.close_lid()
    hs = p.load_module("heaterShakerModuleV1", "D1")
    adapter = hs.load_adapter("opentrons_96_flat_bottom_adapter")
    adapter.load_labware("nest_96_wellplate_200ul_flat")
    hs.open_labware_latch()
    hs.close_labware_latch()
''')
        run = self.analyze(source)
        self.assertEqual(len(run.modules), 2)
        self.assertTrue(any(lw.parent[0] == 'labware' for lw in run.labware.values()))
        planned, scene = self.scene(run, self.folder / 'modules-model')
        check_targets(planned, scene)
        self.assertFalse(planned.warnings)
        with patch('sim.flex_module_assets.load_pack', return_value=None):
            basic_plan, basic_scene = self.scene(run, self.folder / 'basic-model')
            check_targets(basic_plan, basic_scene)
            self.assertNotIn('_detail', (self.folder / 'basic-model' / 'flex.xml').read_text())


if __name__ == '__main__':
    unittest.main()
