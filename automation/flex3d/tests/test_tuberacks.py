"""Tube appearance follows official definitions; positioning and collision proxies stay unchanged."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import mujoco
import numpy as np
from opentrons_shared_data.labware import load_definition

from sim.flex_protocol import load_analysis, plan, scene_spec
from sim.flex_scene import labware_from_definition, load_deck, load_model, write_model
from sim.play_protocol import Scene, check_clearance, check_targets
from sim.view_scene import write_view


class TubeRacks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.tmp.name)
        cls.deck = load_deck()
        source = cls.folder / 'tubes.py'
        source.write_text('''from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    trash = p.load_trash_bin("A3")
    tips = p.load_labware("opentrons_flex_96_tiprack_1000ul", "A1")
    ep15 = p.load_labware("opentrons_24_tuberack_eppendorf_1.5ml_safelock_snapcap", "B1")
    ep2 = p.load_labware("opentrons_24_tuberack_eppendorf_2ml_safelock_snapcap", "B2")
    mixed = p.load_labware("opentrons_10_tuberack_falcon_4x50ml_6x15ml_conical", "C1")
    water = p.define_liquid(name="Water", description="Water", display_color="#55aaff")
    ep15["A1"].load_liquid(water, 1000)
    pip = p.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])
    pip.pick_up_tip()
    for well in [ep15["A1"], ep2["D6"], mixed["A1"], mixed["A3"]]:
        pip.move_to(well.top(-5))
    pip.drop_tip(trash)
''')
        output = source.with_suffix('.analysis.json')
        result = subprocess.run([sys.executable, '-m', 'opentrons.cli', 'analyze', '--json-output', str(output), str(source)],
                                capture_output=True, text=True)
        if result.returncode:
            cls.tmp.cleanup()
            raise RuntimeError(result.stdout + result.stderr)
        cls.analysis = load_analysis(output, cls.deck)
        cls.plan = plan(cls.analysis)
        cls.model_path = write_model(cls.deck, scene_spec(cls.plan), cls.folder / 'scene')
        cls.model = load_model(cls.model_path)
        cls.scene = Scene(cls.plan, cls.model, mujoco.MjData(cls.model))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_ep_and_mixed_rack_targets_and_proxies_use_official_coordinates(self):
        self.assertFalse(self.plan.warnings)
        check_targets(self.plan, self.scene)
        check_clearance(self.plan, self.scene)
        racks = [item for item in self.analysis.labware.values() if item.labware.is_tuberack]
        self.assertEqual([len(item.labware.wells) for item in racks], [24, 24, 10])
        for item in racks:
            definition = load_definition(item.load_name, 2)
            for name, well in item.labware.wells.items():
                raw = definition['wells'][name]
                self.assertEqual((well.x, well.y, well.z, well.depth), (raw['x'], raw['y'], raw['z'], raw['depth']))
                self.assertAlmostEqual(max(z for _, z in well.profile), raw['depth'])
                gid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_GEOM, f'{item.key}_{name}')
                self.assertGreaterEqual(gid, 0)
                self.assertEqual(self.model.geom_group[gid], 3)
                self.assertGreater(self.model.geom_rgba[gid, 3], 0)  # Still participates in clearance.
                expected = np.array([well.x, well.y, well.z + well.depth / 2]) / 1000
                np.testing.assert_allclose(self.model.geom_pos[gid], expected, atol=5.1e-6)  # XML uses 5 decimal meters.
        mixed = racks[-1].labware
        self.assertNotEqual(mixed.wells['A1'].profile, mixed.wells['A3'].profile)

    def test_hidden_collision_proxy_still_blocks_a_path_into_the_rack_wall(self):
        source = self.folder / 'blocked.py'
        script = (self.folder / 'tubes.py').read_text().replace('from opentrons import protocol_api', 'from opentrons import protocol_api, types')
        script = script.replace('    for well in [ep15["A1"], ep2["D6"], mixed["A1"], mixed["A3"]]:\n        pip.move_to(well.top(-5))',
                                '    pip.move_to(ep15["A1"].top(-20).move(types.Point(-16, 0, 0)))')
        source.write_text(script)
        output = source.with_suffix('.analysis.json')
        done = subprocess.run([sys.executable, '-m', 'opentrons.cli', 'analyze', '--json-output', str(output), str(source)],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        blocked = plan(load_analysis(output, self.deck))
        model = load_model(write_model(self.deck, scene_spec(blocked), self.folder / 'blocked-scene'))
        with self.assertRaisesRegex(RuntimeError, r'lw2_side_left'):
            check_clearance(blocked, Scene(blocked, model, mujoco.MjData(model)))

    def test_profile_meshes_are_shared_and_export_has_a_versioned_contract(self):
        meshes = [p for p in self.model_path.parent.rglob('tube_*.obj') if not p.name.startswith('tube_lip_')]
        self.assertEqual(len(list(self.model_path.parent.rglob('tube_lip_*.obj'))), 4)
        self.assertEqual(len(meshes), 4)  # 24 EP1.5 + 24 EP2 + 6x15mL + 4x50mL, four shared profiles.
        view = json.loads(write_view(self.plan, self.scene, self.folder / 'scene').read_text())
        self.assertEqual(view['schema_version'], 1)
        self.assertEqual(view['units'], {'length': 'm', 'time': 's'})
        self.assertEqual(view['coordinate_system'], 'mujoco_world_z_up')
        for transform in view['home'].values():
            self.assertEqual(len(transform), 12)
        for frame in view['frames']:
            self.assertEqual(len(frame['dyn']), len(view['dynamic']))
            self.assertTrue(all(len(values) == 10 for values in frame['dyn']))
        self.assertTrue(all(geom['body'] in map(int, view['home']) for geom in view['geoms']))
        self.assertTrue(all(geom['mesh'] is None or geom['mesh'] < len(view['meshes']) for geom in view['geoms']))

    def test_dark_windowed_racks_keep_browser_materials_and_separate_back_panels(self):
        model = self.model
        view = json.loads(write_view(self.plan, self.scene, self.folder / 'scene').read_text())
        for item in self.analysis.labware.values():
            if not item.labware.is_tuberack:
                continue
            def gid(suffix):
                return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, f'visual_{item.key}_{suffix}')
            front, back, left, right = [gid('window_' + side) for side in ('front', 'back', 'left', 'right')]
            self.assertTrue(all(index >= 0 for index in (front, back, left, right)))
            self.assertAlmostEqual(model.geom_pos[back, 1] - model.geom_pos[front, 1], (item.labware.y - 3.2) / 1000, places=5)
            self.assertAlmostEqual(model.geom_pos[right, 0] - model.geom_pos[left, 0], (item.labware.x - 3.2) / 1000, places=5)
            mat = model.geom_matid[front]
            self.assertTrue(np.all(model.mat_rgba[mat, :3] < 0.25))
            insert = next(geom for geom in view['geoms'] if geom['gid'] == gid('insert'))
            self.assertEqual(insert['metalness'], 0)
            self.assertGreater(insert['roughness'], 0.3)
            self.assertIsNotNone(insert['tex'])
            texture = view['textures'][insert['tex']]['file']
            self.assertTrue((self.model_path.parent / 'flex_assets' / texture).is_file())
            mesh = view['meshes'][insert['mesh']]
            self.assertEqual(len(mesh['uv']), 2 * len(mesh['positions']) // 3)

    def test_current_official_four_in_one_definitions_all_receive_the_new_appearance(self):
        from opentrons_shared_data import get_shared_data_root
        from sim.flex_scene import _tuberack_geoms
        from sim.flex_shell import AssetBook
        definitions = get_shared_data_root() / 'labware/definitions/2'
        book = AssetBook(self.folder / 'all-rack-assets')
        checked = []
        for folder in sorted(definitions.glob('opentrons_*tuberack*')):
            if folder.name.endswith('_acrylic'):  # A separate legacy stand, not the 4-in-1.
                continue
            latest = max(folder.glob('*.json'), key=lambda p: int(p.stem))
            raw = json.loads(latest.read_text())
            if raw.get('metadata', {}).get('displayCategory') != 'tubeRack':
                continue
            with self.subTest(load_name=folder.name, version=latest.stem):
                geoms = _tuberack_geoms('rack', labware_from_definition(raw), set(), {}, book)
                self.assertTrue(any('name="visual_rack_insert"' in g for g in geoms), folder.name)
                self.assertEqual(sum('name="visual_rack_window_' in g for g in geoms), 4)
                checked.append(folder.name)
        self.assertIn('opentrons_24_tuberack_nest_1.5ml_snapcap', checked)
        self.assertIn('opentrons_24_tuberack_eppendorf_1.5ml_safelock_snapcap', checked)
        self.assertGreaterEqual(len(checked), 15)

    def test_legacy_tube_definition_without_inner_profile_keeps_a_simple_fallback(self):
        raw = load_definition('opentrons_24_tuberack_eppendorf_1.5ml_safelock_snapcap', 2)
        raw.pop('innerLabwareGeometry')
        labware = labware_from_definition(raw)
        self.assertTrue(labware.is_tuberack)
        self.assertTrue(all(not well.profile for well in labware.wells.values()))
        from sim.flex_scene import _tuberack_geoms
        from sim.flex_shell import AssetBook
        geoms = _tuberack_geoms('legacy', labware, set(), {}, AssetBook(self.folder / 'legacy-assets'))
        self.assertEqual(sum('name="visual_legacy_tube_' in geom for geom in geoms), 24)


if __name__ == '__main__':
    unittest.main()
