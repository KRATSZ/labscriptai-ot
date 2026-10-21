"""Release contents and determinism; all output stays in temporary directories."""
import hashlib
import json
import posixpath
import re
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

    def test_single_runtime_with_detailed_models_is_complete_and_repeatable(self):
        out = self.folder / 'first'
        out.mkdir()
        for name in ['labscriptai-ot-0.1.0.zip', 'labscriptai-ot-flex3d-details-0.1.1.zip', 'unrelated.txt']:
            (out / name).write_text('previous output')
        first = build(out=self.folder / 'first')
        second = build(out=self.folder / 'second')
        self.assertEqual(first, second)
        self.assertEqual(len(first['assets']), 1)
        self.assertEqual({p.name for p in out.glob('*.zip')}, {first['assets'][0]['name']})
        self.assertTrue((out / 'unrelated.txt').exists())
        for asset in first['assets']:
            a, b = [self.folder / name / asset['name'] for name in ['first', 'second']]
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(hashlib.sha256(a.read_bytes()).hexdigest(), asset['sha256'])
            with zipfile.ZipFile(a) as z:
                self.assertEqual(len(z.namelist()), asset['files'])
                identity = json.loads(z.read('labscriptai-ot/build-info.json'))
                digest = hashlib.sha256()
                for name in z.namelist():
                    if name.endswith('/build-info.json'):
                        continue
                    digest.update(name.removeprefix('labscriptai-ot/').encode() + b'\0' + z.read(name) + b'\0')
                self.assertEqual(identity['content_sha256'], digest.hexdigest())
                self.assertEqual(identity['build_id'], digest.hexdigest()[:16])
                self.assertEqual(identity['version'], first['version'])
                paths = {Path(n).relative_to('labscriptai-ot') for n in z.namelist()}
                self.assertTrue(all(allowed(p) for p in paths))
                self.assertIn(Path('LICENSE'), paths)
                self.assertIn(Path('CITATION.cff'), paths)
                pack = json.loads(z.read('labscriptai-ot/' + str(DETAIL / 'manifest.json')))
                for module in pack['modules'].values():
                    for part in module['parts']:
                        self.assertIn(DETAIL / part['file'], paths)
                self.assertTrue({Path(p) for p in FILES} <= paths)
                self.assertFalse(any('ROADMAP' in str(p) or 'deepseek' in str(p) for p in paths))
                self.assertIn(Path('automation/flex3d/web/vendor/three.module.js'), paths)

    def test_download_quickstart_links_and_setup_helper_are_usable(self):
        built = build(out=self.folder / 'docs')
        with zipfile.ZipFile(self.folder / 'docs' / built['assets'][0]['name']) as z:
            names = set(z.namelist())
            self.assertIn('labscriptai-ot/scripts/configure-cursor.mjs', names)
            for document in ['README.md', 'docs/GETTING_STARTED.md']:
                name = 'labscriptai-ot/' + document
                content = z.read(name).decode()
                for target in re.findall(r'\]\(([^\s)]+)\)', content):
                    if target.startswith(('https:', 'http:', '#', 'mailto:')):
                        continue
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target.split('#')[0]))
                    self.assertTrue(resolved in names or any(n.startswith(resolved.rstrip('/') + '/') for n in names),
                                    f'{document}: missing download target {target}')
                if document.startswith('docs/'):
                    for script in re.findall(r'(?:node|bash) (scripts/[\w.-]+\.(?:mjs|sh))', content):
                        self.assertIn('labscriptai-ot/' + script, names)
                    self.assertNotIn('test/fixtures/', content)

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
        mesh = next((root / DETAIL).rglob('*.obj'))
        mesh_bytes = mesh.read_bytes()
        mesh.unlink()
        with self.assertRaisesRegex(ValueError, 'runtime file'):
            build(root, self.folder / 'missing-model')
        self.assertFalse((self.folder / 'missing-model').exists())
        mesh.write_bytes(mesh_bytes)
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
