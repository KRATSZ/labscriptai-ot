#!/usr/bin/env python3
"""Build a deterministic runtime bundle and an optional Flex module detail pack."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DETAIL = Path('automation/flex3d/cad/flex/modules/detailed')
FILES = '''AGENTS.md LICENSE CITATION.cff README.md pyproject.toml uv.lock server.json
.mcp.json mcp.json install-labscriptai-ot.sh install-labscriptai-ot.ps1
scripts/install-runtime.mjs scripts/verify-setup.mjs scripts/lint-manifests.mjs
servers/opentrons-mcp/index.js servers/opentrons-mcp/package.json servers/opentrons-mcp/package-lock.json
servers/opentrons-mcp/scripts/local_simulation.py servers/opentrons-mcp/scripts/logicpass_check.py
servers/opentrons-mcp/scripts/vision_check.py automation/deck_layout_policy.json
automation/flex3d/viewer.html automation/flex3d/scripts/render_protocol_3d.py
docs/GETTING_STARTED.md docs/GLOSSARY.md docs/MCP_TOOLS.md docs/custom-labware-guide.md docs/deck-vision.md'''.split()
DIRS = '''.claude-plugin .codex-plugin .cursor-plugin .cursor skills policy rules bundled-library
servers/opentrons-mcp/lib automation/vendor automation/flex3d/sim automation/flex3d/web
automation/flex3d/cad docs/runbooks examples'''.split()
EXCLUDE = {'.git', '.venv', 'node_modules', '.agent-runs', '.plugin-data', '__pycache__', 'test', 'tests', 'fixtures'}
SUFFIXES = {'.pyc', '.pyo', '.pt', '.blend', '.blend1', '.glb', '.stl', '.mp4', '.mov', '.pem', '.key'}


def allowed(rel):
    return not (set(rel.parts) & EXCLUDE or any(p.startswith('.env') for p in rel.parts)
                or rel.suffix.lower() in SUFFIXES or rel.name == '.DS_Store')


def checked(root, rel):
    if any((root / part).is_symlink() for part in [rel, *rel.parents]) or not (root / rel).is_file():
        raise ValueError(f'Missing or symlinked runtime file: {rel}')
    return rel


def core_files(root):
    paths = {checked(root, Path(p)) for p in FILES}
    for name in DIRS:
        folder = root / name
        if not folder.is_dir() or folder.is_symlink():
            raise ValueError(f'Missing runtime directory: {name}')
        for path in folder.rglob('*'):
            rel = path.relative_to(root)
            if path.is_file() and not path.is_symlink() and allowed(rel) and not rel.is_relative_to(DETAIL):
                paths.add(checked(root, rel))
    # Keep the small recovery CLIs referenced by runtime guidance.
    for path in (root / 'scripts').glob('*.mjs'):
        if path.name not in {'generate-mcp-docs.mjs'} and allowed(path.relative_to(root)):
            paths.add(checked(root, path.relative_to(root)))
    return sorted(paths)


def detail_files(root):
    manifest = root / DETAIL / 'manifest.json'
    if not manifest.exists():
        return []
    pack = json.loads(manifest.read_text())
    paths = {Path('LICENSE'), Path('CITATION.cff'), DETAIL / 'README.md', DETAIL / 'manifest.json', DETAIL / 'sources.json'}
    for module in pack['modules'].values():
        for part in module['parts']:
            rel = DETAIL / part['file']
            if not (root / rel).resolve().is_relative_to((root / DETAIL).resolve()) or rel.suffix != '.obj':
                raise ValueError(f'Invalid runtime mesh: {rel}')
            paths.add(rel)
    return sorted(checked(root, p) for p in paths)


def write_zip(root, target, paths):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in paths:
            info = zipfile.ZipInfo('labscriptai-ot/' + rel.as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if rel.suffix == '.sh' else 0o100644) << 16
            archive.writestr(info, (root / rel).read_bytes(), compresslevel=9)


def build(root=ROOT, out=None):
    root = Path(root).resolve()
    out = Path(out or root / 'dist').resolve()
    version = json.loads((root / '.codex-plugin/plugin.json').read_text())['version']
    if not version or any(c not in '0123456789abcdefghijklmnopqrstuvwxyz.-' for c in version):
        raise ValueError('Invalid release version')
    bundles = [(f'labscriptai-ot-{version}.zip', core_files(root))]
    detail = detail_files(root)
    if detail:
        bundles.append((f'labscriptai-ot-flex3d-details-{version}.zip', detail))
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as stage:
        stage = Path(stage)
        assets = []
        for name, paths in bundles:
            archive = stage / name
            write_zip(root, archive, paths)
            assets.append({'name': name, 'bytes': archive.stat().st_size,
                           'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': len(paths)})
        result = {'version': version, 'assets': assets}
        (stage / 'release-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
        out.mkdir(parents=True, exist_ok=True)
        for path in stage.iterdir():
            shutil.move(str(path), out / path.name)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(out=args.out)))
