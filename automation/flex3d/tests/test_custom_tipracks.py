"""PE appearance, SDK coordinates, tip visibility and rack returns, all offline."""
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import mujoco
import numpy as np
from opentrons_shared_data.labware import load_definition

from sim import flex_shell
from sim.flex_protocol import load_analysis, plan, scene_spec
from sim.flex_scene import load_deck, load_model, write_model
from sim.play_protocol import Scene, check_clearance, check_targets
from sim.view_scene import write_view
from test_rack_insert import covered, read_obj, top_faces_at

ROOT = Path(__file__).resolve().parents[3]
LABWARE = ROOT / "automation" / "labware"


def protocol_source(definitions, volume):
    capacity = 50 if volume == 50 else 1000
    return f'''import json
from opentrons import protocol_api, types
requirements = {{"robotType": "Flex", "apiLevel": "2.24"}}
DEFINITIONS = json.loads({json.dumps(definitions)!r})
def run(p):
    trash = p.load_trash_bin("A3")
    rack50 = p.load_labware_from_definition(DEFINITIONS[0], "D1")
    rack200 = p.load_labware_from_definition(DEFINITIONS[1], "D2")
    rack = rack{volume}
    single = p.load_instrument("flex_1channel_{capacity}", "left", tip_racks=[rack])
    eight = p.load_instrument("flex_8channel_{capacity}", "right", tip_racks=[rack])
    single.pick_up_tip(rack["A1"])
    single.return_tip()
    single.pick_up_tip(rack["A1"])
    single.drop_tip(trash)
    eight.pick_up_tip(rack["A2"])
    eight.return_tip()
    eight.pick_up_tip(rack["A3"])
    eight.drop_tip(trash)
    single.pick_up_tip(rack["H12"])
    single.drop_tip(trash)
    single.pick_up_tip(rack["A4"])
    single.drop_tip(rack["H12"])
    eight.pick_up_tip(rack["A12"])
    eight.drop_tip(trash)
    eight.pick_up_tip(rack["A5"])
    eight.drop_tip(rack["A12"])
'''


class CustomTipRacks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.tmp.name)
        cls.deck = load_deck()
        cls.definitions = [json.loads((LABWARE / f"pe_{v}a_1_ts_96_tiprack_{v}ul.json").read_text())
                           for v in (50, 200)]
        cls.cases = {}
        for label, volume, definitions in [
            ("50", 50, cls.definitions), ("200", 200, cls.definitions),
            ("standard", 50, [load_definition(f"opentrons_flex_96_tiprack_{v}ul", 1) for v in (50, 200)])
        ]:
            cls.cases[label] = cls.make_scene(label, protocol_source(definitions, volume))

    @classmethod
    def make_scene(cls, label, source):
        file = cls.folder / f"{label}.py"
        file.write_text(source)
        analysis = file.with_suffix(".analysis.json")
        done = subprocess.run([sys.executable, "-m", "opentrons.cli", "analyze", "--check",
                               "--json-output", str(analysis), str(file)], capture_output=True, text=True)
        if done.returncode:
            raise RuntimeError(done.stdout + done.stderr)
        planned = plan(load_analysis(analysis, cls.deck))
        model_path = write_model(cls.deck, scene_spec(planned), cls.folder / f"{label}-scene")
        model = load_model(model_path)
        return planned, Scene(planned, model, mujoco.MjData(model)), model_path

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_real_sdk_single_and_eight_channel_targets_and_clearance(self):
        for label, (planned, scene, _) in self.cases.items():
            with self.subTest(label=label):
                self.assertFalse(planned.warnings)
                hits, json_error, sim_error = check_targets(planned, scene)
                self.assertEqual(len(hits), 16)
                self.assertLess(json_error, 1e-8)
                self.assertLess(sim_error, 0.02)
                margin, _, samples = check_clearance(planned, scene)
                self.assertGreater(margin, 0)
                self.assertGreater(samples, 100)

    def test_62mm_inputs_and_hidden_proxies_remain_authoritative(self):
        for planned, scene, _ in list(self.cases.values())[:2]:
            model = scene.model
            for item, definition in zip(planned.run.labware.values(), self.definitions):
                self.assertEqual(item.labware.z, 62)
                for name, well in item.labware.wells.items():
                    raw = definition["wells"][name]
                    self.assertEqual((well.x, well.y, well.z, well.depth),
                                     (raw["x"], raw["y"], raw["z"], raw["depth"]))
                self.assertEqual(item.labware.tip_length, definition["parameters"]["tipLength"])
                for name in (f"{item.key}_pad", f"body_{item.key}"):
                    gid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name)
                    self.assertEqual(model.geom_group[gid], 3)
                    self.assertGreater(model.geom_rgba[gid, 3], 0)

    def test_rack_return_visibility_and_waste_fall_are_distinct(self):
        for label, (planned, scene, _) in self.cases.items():
            with self.subTest(label=label):
                returned, waste = 0, 0
                for key in planned.keys:
                    scene.apply(key.q, key.state)
                    for rack, wells in scene.rack.items():
                        for well, gid in wells.items():
                            self.assertEqual(scene.model.geom_rgba[gid, 3] > 0, well in key.state.rack[rack])
                    if key.phase == "eject":
                        cmd = planned.run.commands[key.cmd]
                        tool = next(p.tool for p in planned.run.pipettes.values() if p.id == cmd["params"]["pipetteId"])
                        if cmd["commandType"] == "dropTip":
                            self.assertEqual(key.state.falling[tool], 0)
                            returned += 1
                        else:
                            self.assertEqual(key.state.falling[tool], 1)
                            waste += 1
                self.assertEqual((returned, waste), (4, 4))
                rack = next(item.key for item in planned.run.labware.values()
                            if item.labware.load_name.endswith(f"_{50 if label == 'standard' else label}ul"))
                final = planned.keys[-1].state.rack[rack]
                self.assertIn("H12", final)
                self.assertTrue(all(f"{row}12" in final for row in "ABCDEFGH"))
                self.assertNotIn("A1", final)
                self.assertNotIn("A4", final)
                self.assertTrue(all(not any(mounted) for mounted in planned.keys[-1].state.mounted.values()))

    def test_seated_tip_mesh_and_nozzle_overlap_match_sdk(self):
        for planned, scene, _ in list(self.cases.values())[:2]:
            for key in planned.keys:
                if key.phase != "seat":
                    continue
                scene.apply(key.q, key.state)
                for pip in planned.run.pipettes.values():
                    for channel, (mounted, (gid, _, _)) in enumerate(zip(key.state.mounted[pip.tool], scene.tips[pip.tool])):
                        if not mounted:
                            continue
                        mesh = scene.model.geom_dataid[gid]
                        start, count = scene.model.mesh_vertadr[mesh], scene.model.mesh_vertnum[mesh]
                        verts = scene.model.mesh_vert[start:start + count]
                        world = np.einsum("nj,ij->ni", verts, scene.data.geom_xmat[gid].reshape(3, 3)) + scene.data.geom_xpos[gid]
                        self.assertTrue(np.all(np.isfinite(world)))
                        self.assertAlmostEqual(np.ptp(world[:, 2]) * 1000, pip.tip.length_mm, delta=0.015)
                        # At the press/seat key, the tip is still in the exact rack pose.
                        rack = next(item for item in planned.run.labware.values()
                                    if item.id == planned.run.commands[key.cmd]["params"]["labwareId"])
                        well = rack.labware.wells["A1"]
                        end = self.deck.corner[2] + key.state.origin[rack.key][2] + well.z + well.depth - pip.tip.length_mm
                        self.assertAlmostEqual(world[:, 2].min() * 1000, end, delta=0.015)
                        site = "tip_left" if pip.channels == 1 else f"tip_8r_{'ABCDEFGH'[channel]}"
                        sid = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_SITE, site)
                        overlap = (world[:, 2].max() - scene.data.site_xpos[sid, 2]) * 1000
                        self.assertAlmostEqual(overlap, pip.tip.length_mm - pip.tip.reach_mm, delta=0.015)

    def test_open_mesh_has_annular_lips_without_changing_liquid_profile(self):
        for definition in self.definitions:
            length = definition["parameters"]["tipLength"]
            diameter = definition["wells"]["A1"]["diameter"]
            profile = flex_shell.tip_visual_profile(length, diameter)
            self.assertEqual(profile[:9], flex_shell.tip_profile(length, diameter)[1:-1])
            with tempfile.TemporaryDirectory() as tmp:
                book = flex_shell.AssetBook(Path(tmp))
                name = book.tip_mesh(length, diameter, hollow=True)
                verts, _, faces = read_obj(Path(tmp) / f"{name}.obj")
                self.assertAlmostEqual(verts[:, 2].min(), 0)
                self.assertAlmostEqual(verts[:, 2].max(), length / 1000)
                for z in (0, length / 1000):
                    cap = top_faces_at(verts, faces, z)
                    self.assertTrue(cap)
                    self.assertFalse(covered(cap, (0, 0)))
        pip = next(iter(self.cases["50"][0].run.pipettes.values()))
        with patch.object(flex_shell, "tip_visual_profile", side_effect=AssertionError("visual used for liquid")):
            Scene._tip_volume_table(pip.tip)

    def test_standard_racks_keep_their_original_meshes_and_visuals_export(self):
        _, _, path = self.cases["standard"]
        self.assertFalse(list(path.parent.rglob("tip_*_open.obj")))
        self.assertNotIn("visual_lw1_", path.read_text())
        planned, scene, path = self.cases["50"]
        view = json.loads(write_view(planned, scene, path.parent).read_text())
        tips = [g for g in view["geoms"] if g["gid"] in scene.rack["lw1"].values()]
        self.assertEqual(len(tips), 96)
        self.assertTrue(all("roughness" in g for g in tips))
        self.assertFalse(any(g["gid"] == mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_GEOM, "body_lw1")
                             for g in view["geoms"]))

    def test_hidden_body_still_rejects_an_off_hole_move(self):
        source = protocol_source(self.definitions, 50)
        source += '    single.pick_up_tip(rack["A6"])\n    single.move_to(rack["A1"].top(-20).move(types.Point(-10, 0, 0)))\n'
        planned, scene, _ = self.make_scene("blocked", source)
        with self.assertRaisesRegex(RuntimeError, r"runs into body_lw1"):
            check_clearance(planned, scene)

    def test_builder_uses_installed_shared_data_and_preserves_dimensions(self):
        file = LABWARE / "build_pe_tipracks.py"
        spec = importlib.util.spec_from_file_location("build_pe_tipracks_test", file)
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as tmp, patch.object(builder, "LABWARE_DIR", Path(tmp)), redirect_stdout(io.StringIO()):
            self.assertEqual(builder.main(), 0)
            for definition in self.definitions:
                generated = json.loads((Path(tmp) / f'{definition["parameters"]["loadName"]}.json').read_text())
                self.assertEqual(generated, definition)


if __name__ == "__main__":
    unittest.main()
