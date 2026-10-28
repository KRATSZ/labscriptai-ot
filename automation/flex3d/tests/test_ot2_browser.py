"""Browser export must carry the accepted OT-2 module poses, not just the mesh."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np

from sim.web_player import Model

ROOT = Path(__file__).resolve().parents[1]


class OT2BrowserExport(unittest.TestCase):
    def test_exported_module_rotation_and_dynamic_state_match_native_keyframes(self):
        python = os.environ.get("OPENTRONS_OT2_PYTHON", str(ROOT.parents[1] / ".venv-ot2/bin/python"))
        with tempfile.TemporaryDirectory(prefix="OT2-中文路径-") as td:
            folder = Path(td)
            source = ROOT / "tests/ot2_fixtures/protocols/thermocycler.py"
            analysis = folder / "analysis.json"
            done = subprocess.run([python, "-m", "opentrons.cli", "analyze", "--check", "--json-output", str(analysis), str(source)], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            model = Model("test", analysis, folder)
            self.addCleanup(model.close)
            view = json.loads(model.view_path.read_text())
            self.assertEqual(model.info()["robot_type"], "OT-2 Standard")
            self.assertEqual(len(view["frames"]), len(model.plan.keys))
            rotated = []
            for index, (key, frame) in enumerate(zip(model.plan.keys, view["frames"])):
                model.scene.apply(key.q, key.state, key.t)
                for gid, pack in zip(view["dynamic"], frame["dyn"]):
                    native = model.scene.model
                    # Invisible liquid columns retain their last height in the
                    # native scene. Only visible poses affect the rendered frame.
                    if pack[9] > .02:
                        np.testing.assert_allclose(pack[:3], native.geom_pos[gid], atol=6e-7)
                    np.testing.assert_allclose(pack[10:14], native.geom_quat[gid], atol=6e-7)
                    if index and not np.allclose(pack[10:14], view["frames"][0]["dyn"][view["dynamic"].index(gid)][10:14]):
                        rotated.append(gid)
            self.assertTrue(rotated, "thermocycler skins must rotate in the browser export")
            self.assertTrue(all((folder / texture["file"]).is_file() for texture in view["textures"]))
            self.assertIsNone(model._renderer, "mesh preview must not need native OpenGL")


if __name__ == "__main__":
    unittest.main()
