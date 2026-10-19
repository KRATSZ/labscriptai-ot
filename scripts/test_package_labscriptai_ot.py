"""Release contents and determinism; all output stays in temporary directories."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile
from package_labscriptai_ot import ROOT, DETAIL, FILES, allowed, build


class ReleasePackage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)

    def test_runtime_and_optional_pack_are_complete_and_repeatable(self):
        first = build(out=self.folder / 'first')
        second = build(out=self.folder / 'second')
        self.assertEqual(first, second)
        self.assertEqual(len(first['assets']), 2)
        for asset in first['assets']:
            a, b = [self.folder / name / asset['name'] for name in ['first', 'second']]
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(hashlib.sha256(a.read_bytes()).hexdigest(), asset['sha256'])
            with zipfile.ZipFile(a) as z:
                paths = {Path(n).relative_to('labscriptai-ot') for n in z.namelist()}
                self.assertTrue(all(allowed(p) for p in paths))
                self.assertIn(Path('LICENSE'), paths)
                self.assertIn(Path('CITATION.cff'), paths)
                if 'details' in asset['name']:
                    pack = json.loads(z.read('labscriptai-ot/' + str(DETAIL / 'manifest.json')))
                    for module in pack['modules'].values():
                        for part in module['parts']:
                            self.assertIn(DETAIL / part['file'], paths)
                else:
                    self.assertTrue({Path(p) for p in FILES} <= paths)
                    self.assertFalse(any(p.is_relative_to(DETAIL) for p in paths))
                    self.assertFalse(any('ROADMAP' in str(p) or 'deepseek' in str(p) for p in paths))
                    self.assertIn(Path('automation/flex3d/web/vendor/three.module.js'), paths)

    def test_missing_runtime_file_fails_before_creating_archives(self):
        root = self.folder / 'broken'
        (root / '.codex-plugin').mkdir(parents=True)
        shutil.copy(ROOT / '.codex-plugin/plugin.json', root / '.codex-plugin/plugin.json')
        with self.assertRaisesRegex(ValueError, 'runtime file'):
            build(root, self.folder / 'out')
        self.assertFalse((self.folder / 'out').exists())

    def test_injected_secrets_and_symlinks_stay_out_of_actual_archives(self):
        original = build(out=self.folder / 'original')
        with zipfile.ZipFile(self.folder / 'original' / original['assets'][0]['name']) as z:
            z.extractall(self.folder / 'extracted')
        root = self.folder / 'extracted' / 'labscriptai-ot'
        secret = self.folder / 'private.txt'
        secret.write_text('MUST_NOT_SHIP')
        for name in ['.env', '.env.production', 'secret.key', 'secret.pem', 'model.pt', 'model.blend']:
            (root / 'skills' / name).write_text('MUST_NOT_SHIP')
        (root / 'skills' / 'linked.txt').symlink_to(secret)
        result = build(root, self.folder / 'filtered')
        self.assertEqual(len(result['assets']), 1)
        with zipfile.ZipFile(self.folder / 'filtered' / result['assets'][0]['name']) as z:
            self.assertFalse(any(b'MUST_NOT_SHIP' in z.read(name) for name in z.namelist()))


if __name__ == '__main__':
    unittest.main()
