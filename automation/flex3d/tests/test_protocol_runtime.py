"""Analyzer selection is static and keeps Flex's configured runtime intact."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "servers/opentrons-mcp/scripts"))
from protocol_runtime import RuntimeSelectionError, protocol_robot, select_python, verify_ot2_python


class ProtocolRuntime(unittest.TestCase):
    def test_literals_legacy_and_dynamic_requirements(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / "protocol.py"
            for code, expected in [
                ('requirements = {"robotType": "Flex", "apiLevel": "2.24"}', "Flex"),
                ('requirements = {"robotType": "OT-2", "apiLevel": "2.20"}', "OT-2"),
                ('metadata = {"apiLevel": "2.13"}', "OT-2"),
                ('requirements = dict(robotType="Flex")', None),
                ('requirements = {"apiLevel": "2.24"}\nrequirements["robotType"] = "Flex"', None),
                ('requirements = {}\nrequirements.update(robotType="Flex")', None),
                ('requirements = {"robotType": "alien"}', None),
                ('invalid syntax ...', None),
            ]:
                source.write_text(code)
                with self.subTest(code=code):
                    self.assertEqual(protocol_robot(source), expected)
            source.write_text('requirements = {"robotType": "Flex"}')
            with patch.dict(os.environ, {"OPENTRONS_OT2_PYTHON": "/dedicated/ot2/python"}), patch("protocol_runtime.verify_ot2_python", side_effect=lambda value: str(value)):
                self.assertEqual(select_python("/existing/flex/python", source), "/existing/flex/python")
                source.write_text('requirements = {"robotType": "OT-2"}')
                self.assertEqual(select_python("/existing/flex/python", source), "/dedicated/ot2/python")

    def test_rejects_wrong_or_missing_ot2_analyzer(self):
        import subprocess
        with patch("protocol_runtime.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "9.1.2\n", "")):
            with self.assertRaisesRegex(RuntimeSelectionError, "8.8.2"):
                verify_ot2_python("/wrong/python")
        with patch("protocol_runtime.subprocess.run", side_effect=FileNotFoundError("missing")):
            with self.assertRaisesRegex(RuntimeSelectionError, "install-runtime"):
                verify_ot2_python("/missing/python")

    def test_source_layout_parameters_preserve_ot2_analyzer_selection(self):
        import json
        import subprocess
        root = Path(__file__).resolve().parents[3]
        source = root / "automation/flex3d/tests/ot2_fixtures/protocols/p10_single.py"
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "workspace"
            (workspace / "opentrons/api/src/opentrons").mkdir(parents=True)
            (workspace / "opentrons/shared-data/python").mkdir(parents=True)
            done = subprocess.run([sys.executable, str(root / "servers/opentrons-mcp/scripts/local_simulation.py"),
                                   "analyze", "--workspace-root", str(workspace), "--json-output", str(Path(td) / "analysis.json"), str(source)],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            result = json.loads(done.stdout)
            self.assertTrue(result["ok"], result)
            self.assertTrue(result["source_layout_ready"])
            self.assertEqual(result["python"], select_python(sys.executable, source))
            self.assertEqual(result["robot_type"], "OT-2 Standard")


if __name__ == "__main__":
    unittest.main()
