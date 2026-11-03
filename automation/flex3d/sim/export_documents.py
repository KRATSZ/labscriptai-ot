"""Produce portable documents for artifact API v1. No HTTP server or robot access."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def encoded(value):
    return base64.b64encode(value).decode('ascii')


def replace(source, target, value):
    if target not in source:
        raise ValueError(f'Unsupported bundled viewer: {target}')
    return source.replace(target, value)


def animation_document(analysis, folder):
    from sim.web_player import Model
    model = Model('portable', analysis, folder)
    try:
        viewer = (ROOT / 'viewer.html').read_text(encoding='utf-8')
        script = (ROOT / 'web/viewer.js').read_text(encoding='utf-8')
        viewer = replace(viewer, '/vendor/three.module.js', '__ARTIFACT_THREE__')
        viewer = replace(viewer, '/viewer.js', '__ARTIFACT_SCRIPT__')
        script = replace(script, 'let key = params.get("key");', 'let key = "portable";')
        script = replace(script, '/vendor/OrbitControls.js', '__ARTIFACT_ORBIT__')
        for name in ('info', 'analysis.json', 'view.json'):
            script = replace(script, f'`/flex3d/${{key}}/{name}`', json.dumps('__ARTIFACT_' + name.split('.')[0].upper() + '__'))
        script = replace(script, '`/flex3d/${key}/assets/${item.file}`', 'globalThis.__artifactAssets[item.file]')
        info = model.info()
        info['experiment_figure'] = False
        view = json.loads(model.view_path.read_text(encoding='utf-8'))
        assets = {}
        for item in view.get('textures', []):
            name = item['file']
            if not re.fullmatch(r'[A-Za-z0-9_.-]+\.png', name):
                raise ValueError('Invalid texture filename')
            candidates = [folder / 'flex_assets' / name, folder / name]
            file = next((p for p in candidates if p.is_file()), None)
            if file is None:
                raise ValueError(f'Missing texture: {name}')
            assets[name] = encoded(file.read_bytes())
        payload = encoded(json.dumps({
            'viewer': viewer, 'script': script,
            'three': encoded((ROOT / 'web/vendor/three.module.js').read_bytes()),
            'orbit': encoded((ROOT / 'web/vendor/OrbitControls.js').read_bytes()),
            'info': encoded(json.dumps(info).encode()), 'analysis': encoded(analysis.read_bytes()),
            'view': encoded(model.view_path.read_bytes()), 'assets': assets,
        }, ensure_ascii=False).encode())
        return '''<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src blob: data:; connect-src blob:; worker-src blob:; base-uri 'none'; form-action 'none'"><script>(()=>{
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const p=JSON.parse(new TextDecoder().decode(bytes(''' + json.dumps(payload) + ''')));
const blob=(data,type)=>URL.createObjectURL(new Blob([data],{type}));
const replacements={THREE:blob(bytes(p.three),'text/javascript'),ORBIT:blob(bytes(p.orbit),'text/javascript'),INFO:blob(bytes(p.info),'application/json'),ANALYSIS:blob(bytes(p.analysis),'application/json'),VIEW:blob(bytes(p.view),'application/json')};
globalThis.__artifactAssets=Object.fromEntries(Object.entries(p.assets).map(([name,data])=>[name,blob(bytes(data),'image/png')]));
let script=p.script;for(const [key,value] of Object.entries(replacements))script=script.replaceAll('__ARTIFACT_'+key+'__',value);
replacements.SCRIPT=blob(script,'text/javascript');
let html=p.viewer;for(const [key,value] of Object.entries(replacements))html=html.replaceAll('__ARTIFACT_'+key+'__',value);
document.open();document.write(html);document.close();
})()</script>'''
    finally:
        model.close()


def setup_document(analysis, output):
    sys.path.insert(0, str(ROOT.parent / 'figures'))
    from experiment_figure import generate
    result = generate(analysis, output)
    folder = Path(result['directory'])
    page = (folder / 'setup.html').read_text(encoding='utf-8')
    page = re.sub(r'<script>.*?</script>', '', page, flags=re.S)
    page = re.sub(r'<a id="animation"[^>]*>.*?</a>', '', page)
    page = re.sub(r'<nav>.*?</nav>', '', page, flags=re.S)
    page = re.sub(r'<p><a[^>]+download>.*?</a></p>', '', page)
    page = re.sub(r'<a[^>]+target="_blank">(.*?)</a>', r'\1', page, flags=re.S)
    for name in result['images']:
        uri = f'data:image/png;base64,{encoded((folder / name).read_bytes())}'
        page = page.replace(f'src="{name}"', f'src="{uri}"')
    page = page.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">')
    return page, [folder / name for name in result['files'] if name != 'setup.html']


def export(analysis, output):
    analysis = Path(analysis).resolve()
    raw = analysis.read_bytes()
    if not raw or len(raw) > 16 * 1024 * 1024:
        raise ValueError('Analysis must be 1–16777216 bytes')
    parsed = json.loads(raw)
    if not isinstance(parsed.get('commands'), list) or parsed.get('errors'):
        raise ValueError('A successful analysis is required')
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='documents-', dir=output))
    documents = {}
    attachments = []
    for name, build in [('animation', lambda: animation_document(analysis, folder)),
                        ('setup', lambda: setup_document(analysis, output / 'figures'))]:
        try:
            value = build()
            if name == 'setup':
                value, files = value
                for file in files:
                    raw_file = file.read_bytes()
                    mime = 'image/png' if file.suffix == '.png' else 'text/csv' if file.suffix == '.csv' else 'application/json'
                    attachments.append({'name': file.name, 'path': str(file), 'mime': mime, 'bytes': len(raw_file), 'sha256': hashlib.sha256(raw_file).hexdigest()})
            data = value.encode('utf-8')
            if len(data) > 64 * 1024 * 1024:
                raise ValueError('Document exceeds 64 MiB')
            file = folder / f'{name}.html'
            file.write_bytes(data)
            documents[name] = {'status': 'ready', 'path': str(file), 'mime': 'text/html',
                               'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        except Exception as error:
            documents[name] = {'status': 'unavailable', 'message': str(error)[:2000]}
    return {'ok': any(doc['status'] == 'ready' for doc in documents.values()), 'artifact_api': 1,
            'analysis_sha256': hashlib.sha256(raw).hexdigest(), 'documents': documents, 'attachments': attachments}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analysis', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(export(args.analysis, args.out)))
    except Exception as error:
        print(json.dumps({'ok': False, 'artifact_api': 1, 'message': str(error)[:2000]}))
        sys.exit(1)
