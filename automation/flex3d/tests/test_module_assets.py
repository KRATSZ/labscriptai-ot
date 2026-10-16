"""Geometry and playback regressions; never connects to a robot."""
import json
import tempfile
import unittest
from pathlib import Path

import mujoco
import numpy as np

from sim.flex_module_assets import load_pack
from sim.flex_protocol import blend, load_analysis, plan, scene_spec
from sim.flex_scene import load_deck, load_model, robot_m, write_model
from sim.play_protocol import Scene
from sim.view_scene import write_view


class ModuleAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if load_pack() is None:
            raise unittest.SkipTest('Shared detailed module asset pack is not configured')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.tmp.name)
        specs = [('thermocyclerModuleV2', 'B1'), ('heaterShakerModuleV1', 'D1'),
                 ('temperatureModuleV2', 'C3'), ('magneticBlockV1', 'D2'), ('absorbanceReaderV1', 'D3')]
        commands = [{'commandType': 'loadModule', 'params': {'model': m, 'location': {'slotName': s}},
                     'result': {'moduleId': f'm{i}'}} for i, (m, s) in enumerate(specs)]
        commands += [{'commandType': k, 'params': {'moduleId': m}} for k, m in [
            ('thermocycler/closeLid', 'm0'), ('thermocycler/openLid', 'm0'),
            ('heaterShaker/openLabwareLatch', 'm1'), ('heaterShaker/closeLabwareLatch', 'm1'),
            ('absorbanceReader/openLid', 'm4'), ('absorbanceReader/closeLid', 'm4')]]
        path = cls.folder/'probe.json'
        path.write_text(json.dumps({'robotType': 'OT-3 Standard', 'commands': commands}))
        cls.deck = load_deck()
        cls.plan = plan(load_analysis(path, cls.deck))
        cls.model = load_model(write_model(cls.deck, scene_spec(cls.plan), cls.folder))
        cls.scene = Scene(cls.plan, cls.model, mujoco.MjData(cls.model))

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'tmp'): cls.tmp.cleanup()

    def test_every_interface_stays_on_official_addressable_origin(self):
        _, pack = load_pack()
        self.scene.at(0)
        for mod in self.plan.run.modules.values():
            bid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, f'{mod.key}_detail')
            measured = self.scene.data.xpos[bid] + np.array(pack[mod.model]['interface_origin_mm'])*.001
            np.testing.assert_allclose(measured, robot_m(self.deck, mod.area_mm), atol=1e-9)

    def test_hinge_interpolates_and_retains_collision_proxy(self):
        step = next(s for s in self.plan.steps if s.kind == 'thermocycler/closeLid')
        angles = []
        bid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, 'mod1_detail_lid')
        for t in (step.t0, (step.t0+step.t1)/2, step.t1):
            self.scene.at(t)
            angles.append(2*np.arctan2(self.model.body_quat[bid, 1], self.model.body_quat[bid, 0]))
        self.assertLess(angles[0], angles[1]); self.assertLess(angles[1], angles[2])
        self.assertAlmostEqual(angles[1], (angles[0]+angles[2])/2, places=6)
        gid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_GEOM, 'mod1_lid')
        self.assertEqual(self.model.geom_bodyid[gid], bid)
        self.scene.at(step.t0)
        self.assertGreater(self.model.geom_rgba[gid, 3], .9)

    def test_latches_move_separately_and_reader_lid_is_not_hinged(self):
        step = next(s for s in self.plan.steps if s.kind == 'heaterShaker/openLabwareLatch')
        ids = [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, f'mod2_detail_{n}')
               for n in ('latch_front', 'latch_back')]
        self.scene.at(step.t0); start=self.model.body_pos[ids].copy()
        self.scene.at(step.t1); end=self.model.body_pos[ids].copy()
        np.testing.assert_allclose(end-start, [[0,-.007,0],[0,.007,0]], atol=1e-9)
        reader = next(s for s in self.plan.steps if s.kind == 'absorbanceReader/openLid')
        bid=mujoco.mj_name2id(self.model,mujoco.mjtObj.mjOBJ_BODY,'mod5_detail_lid')
        self.scene.at(reader.t0); a=self.model.body_pos[bid].copy()
        self.scene.at(reader.t1); b=self.model.body_pos[bid].copy()
        np.testing.assert_allclose(b-a,[0,-.13,0],atol=1e-9)
        np.testing.assert_allclose(self.model.body_quat[bid],[1,0,0,0],atol=1e-9)

    def test_browser_export_contains_real_meshes_and_motion(self):
        payload=json.loads(write_view(self.plan,self.scene,self.folder).read_text())
        self.assertGreater(len(payload['meshes']),30)
        self.assertGreaterEqual(len(payload['moving']),4)
        proxies={i for i in range(self.model.ngeom) if self.model.geom_group[i]==5}
        self.assertFalse(proxies & {g['gid'] for g in payload['geoms']})

    def test_optional_temperature_insert_is_not_baked_into_bare_module(self):
        self.assertFalse(any('optional' in (mujoco.mj_id2name(self.model,mujoco.mjtObj.mjOBJ_GEOM,g) or '')
                             for g in range(self.model.ngeom)))


if __name__ == '__main__': unittest.main()
