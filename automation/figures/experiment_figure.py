"""Data-driven setup PNG and exact starting-liquid table; no robot or 3D imports.

Gao, Yuan et al., bioRxiv 2025, DOI: 10.1101/2025.09.30.679666.
This is a presentation of analysis declarations, not a second liquid ledger.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import re
import shutil
import tempfile
from collections import defaultdict
from pathlib import Path

SCHEMA = 1
HERE = Path(__file__).resolve().parent
FONT = HERE / 'assets/NotoSansSC-Regular.otf'
COLORS = ['#087c83', '#a36c18', '#416e98', '#775d9a', '#a14d52', '#44783e']
INK, MUTED, LINE, PALE = '#172f40', '#536875', '#dce5e9', '#e8f4f3'
MODULE_NAMES = {'temperatureModuleV1': '温控模块', 'temperatureModuleV2': '温控模块',
                'thermocyclerModuleV1': 'PCR 模块', 'thermocyclerModuleV2': 'PCR 模块',
                'heaterShakerModuleV1': '加热震荡模块', 'magneticModuleV1': '磁力模块',
                'magneticModuleV2': '磁力模块', 'magneticBlockV1': '磁力块',
                'absorbanceReaderV1': '吸光度模块'}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'Invalid declared volume: {value!r}')
    return float(value)


def fmt(value):
    return f'{value:g}'


def build_model(raw):
    """Only declared starting amounts are quantities. Transfers are paths, not recipes."""
    if not isinstance(raw, dict) or not isinstance(raw.get('commands'), list):
        raise ValueError('Analysis must contain commands')
    if raw.get('errors'):
        raise ValueError('Analysis failed; fix the protocol before generating its setup image')
    aliases = {'flex': 'Flex', 'ot-3 standard': 'Flex', 'ot-2': 'OT-2', 'ot-2 standard': 'OT-2'}
    declarations = [raw.get('robotType')] + [raw[k].get('robotType') for k in ('metadata', 'config') if isinstance(raw.get(k), dict)]
    kinds = {aliases.get(str(v).lower(), 'unsupported') for v in declarations if v is not None}
    if len(kinds) != 1 or 'unsupported' in kinds:
        raise ValueError('Missing, unsupported or conflicting robotType; analyze an OT-2 or Flex protocol')
    robot = kinds.pop()
    modules, vessels, pipettes, waste = {}, {}, [], {}
    liquids = {v['id']: {'name': v.get('displayName') or v['id'], 'code': i + 1,
                          'color': COLORS[i % len(COLORS)]} for i, v in enumerate(raw.get('liquids', []))}
    initial, routes, current_sources = defaultdict(dict), set(), {}
    transfers_started = False
    for cmd in raw['commands']:
        if cmd.get('status') not in (None, 'succeeded'):
            continue
        kind, p, result = cmd.get('commandType'), cmd.get('params', {}), cmd.get('result') or {}
        if kind == 'loadModule':
            key = result['moduleId']
            modules[key] = {'id': key, 'model': result.get('model') or p['model'], 'location': p.get('location', {})}
        elif kind == 'loadLabware':
            key, definition = result['labwareId'], result.get('definition')
            if not isinstance(definition, dict) or not isinstance(definition.get('wells'), dict):
                raise ValueError('Labware definition missing from analysis; re-analyze the protocol')
            vessels[key] = {'id': key, 'load_name': p['loadName'],
                            'name': p.get('displayName') or definition.get('metadata', {}).get('displayName') or p['loadName'],
                            'location': p.get('location', {}), 'definition': definition, 'initial': {}}
        elif kind == 'loadPipette':
            pipettes.append({'name': p['pipetteName'], 'mount': p['mount']})
        elif kind == 'loadLiquid':
            if transfers_started:
                raise ValueError('Liquid declarations occur after transfers; a single starting setup cannot represent them')
            if p['liquidId'] not in liquids:
                raise ValueError('Declared liquid identity missing from analysis')
            for well, volume in p['volumeByWell'].items():
                # Same overwrite semantics as the existing flex_protocol loadLiquid handler.
                # A declaration is not an instruction to mix with a previous declaration.
                initial[(p['labwareId'], well)] = {p['liquidId']: number(volume)}
        elif kind in ('pickUpTip', 'dropTip', 'dropTipInPlace', 'dropTipInTrash'):
            current_sources.pop(p.get('pipetteId'), None)
        elif kind == 'aspirate' and p.get('labwareId'):
            transfers_started = True
            current_sources[p.get('pipetteId')] = p['labwareId']
        elif kind == 'dispense' and p.get('labwareId'):
            transfers_started = True
            source = current_sources.get(p.get('pipetteId'))
            if source and source != p['labwareId']:
                routes.add((source, p['labwareId']))
        area = p.get('addressableAreaName', '')
        match = re.fullmatch(r'movableTrash([A-D][1-3])', area)
        if match:
            waste[match[1]] = '垃圾桶'
        elif area.startswith('wasteChute'):
            waste['D3'] = '废料滑槽'

    def slot(location, trail=()):
        if isinstance(location, str):
            return '离台' if location == 'offDeck' else location
        if location.get('slotName') is not None:
            return str(location['slotName'])
        for field, collection in [('moduleId', modules), ('labwareId', vessels)]:
            key = location.get(field)
            if key:
                if key in trail or key not in collection:
                    raise ValueError('Unresolved or cyclic labware placement')
                return slot(collection[key]['location'], trail + (key,))
        if location.get('addressableAreaName'):
            return str(location['addressableAreaName'])
        return '未知'

    for item in [*modules.values(), *vessels.values()]:
        item['slot'] = slot(item['location'])
    for (key, well), mix in initial.items():
        if key not in vessels or well not in vessels[key]['definition']['wells']:
            raise ValueError(f'Declared well missing from labware definition: {well}')
        vessels[key]['initial'][well] = mix
    # An adapter has a child labware. Do not draw it as a second liquid plate.
    parents = {v['location'].get('labwareId') for v in vessels.values() if isinstance(v['location'], dict)}
    for item in vessels.values():
        item['adapter'] = item['id'] in parents
        item['tiprack'] = bool(item['definition'].get('parameters', {}).get('isTiprack'))
    return {'schema': SCHEMA, 'title': raw.get('metadata', {}).get('protocolName') or '实验配置',
            'robot': robot, 'state': 'declared_initial', 'liquids': liquids, 'labware': list(vessels.values()),
            'modules': list(modules.values()), 'pipettes': pipettes, 'waste': waste,
            'routes': [list(route) for route in sorted(routes)]}


class Canvas:
    def __init__(self, width, height):
        from PIL import Image, ImageDraw
        self.image = Image.new('RGB', (width, height), 'white')
        self.draw = ImageDraw.Draw(self.image)
        self.fonts = {}

    def font(self, size):
        from PIL import ImageFont
        if size not in self.fonts:
            self.fonts[size] = ImageFont.truetype(str(FONT), size)
        return self.fonts[size]

    def text(self, x, y, label, size=24, color=INK, width=None, anchor=None):
        label = str(label)
        if width is not None:
            # Ellipsize image labels; the exact unabridged value is in HTML/CSV/JSON.
            while self.draw.textlength(label, font=self.font(size)) > width and label:
                label = label[:-2] + '…' if len(label) > 2 else ''
        self.draw.text((x, y), label, fill=color, font=self.font(size), anchor=anchor)

    def rect(self, x, y, w, h, color='white', outline=LINE, radius=7, stroke=2):
        self.draw.rounded_rectangle((x, y, x+w, y+h), radius=radius, fill=color, outline=outline, width=stroke)

    def circle(self, x, y, r, color='white', outline=LINE, stroke=2):
        self.draw.ellipse((x-r, y-r, x+r, y+r), fill=color, outline=outline, width=stroke)

    def line(self, x, y, x2, y2, color=LINE, stroke=2):
        self.draw.line((x,y,x2,y2), fill=color, width=stroke)


def mix_label(model, mix):
    return ' + '.join(f"{model['liquids'][key]['name']} {fmt(volume)} μL" for key, volume in mix.items())


def groups(item):
    collected = defaultdict(list)
    for well, mix in item['initial'].items():
        collected[tuple(sorted(mix.items()))].append(well)
    return [(wells, dict(mix)) for mix, wells in collected.items()]


def draw_plate(c, model, item, x, y, width, height, labels=True):
    wells = item['definition']['wells']
    if not wells:
        return
    xs, ys = sorted({v['x'] for v in wells.values()}), sorted({v['y'] for v in wells.values()}, reverse=True)
    px = min((b-a for a,b in zip(xs,xs[1:])),default=12)
    py = min((a-b for a,b in zip(ys,ys[1:])),default=max(v.get('yDimension',v.get('diameter',12)) for v in wells.values()))
    scale = min(width/(xs[-1]-xs[0]+px),height/(ys[0]-ys[-1]+py))
    ox=x+(width-(xs[-1]-xs[0])*scale)/2
    oy=y+(height-(ys[0]-ys[-1])*scale)/2
    r = min(px*scale*.29,py*scale*.29,23)
    for name, w in wells.items():
        xx, yy = ox+(w['x']-xs[0])*scale, oy+(ys[0]-w['y'])*scale
        mix = item['initial'].get(name)
        color = model['liquids'][next(iter(mix))]['color'] if mix else None
        known_empty = mix is not None and sum(mix.values()) == 0
        if item['tiprack']:
            color = COLORS[0]
        if w.get('shape')=='rectangular':
            ww,hh=w.get('xDimension',px*.8)*scale*.8,w.get('yDimension',py*.8)*scale*.8
            c.rect(xx-ww/2,yy-hh/2,ww,hh,'white' if known_empty else color or '#f7f9fa',color or LINE,radius=6)
        else:c.circle(xx, yy, r, 'white' if known_empty else color or '#f7f9fa', color or LINE, 2)
        if mix and r >= 12:
            code = '0' if known_empty else str(model['liquids'][next(iter(mix))]['code']) if len(mix) == 1 else '+'
            c.text(xx, yy, code, max(12, int(r)), color if known_empty else 'white', anchor='mm')
        if labels and len(xs) <= 24 and w['y'] == ys[0]:
            c.text(xx, oy-py*scale*.5-7, re.sub(r'^[A-Za-z]+', '', name), 17, MUTED, anchor='mm')
        if labels and len(ys) <= 16 and w['x'] == xs[0]:
            c.text(ox-px*scale*.5-7, yy, re.sub(r'\d+$', '', name), 17, MUTED, anchor='mm')


def render_page(model, items, out, page, total):
    card_heights = [max(550,160+min(len(groups(v)),8)*70) for v in items]
    height = max(1300, 305 + sum(card_heights) + 80)
    c = Canvas(2000, height)
    c.text(65,30,'LABSCRIPT AI  /  EXPERIMENT ATLAS',20,COLORS[0])
    c.text(65,77,model['title'],44,width=1850)
    c.text(65,145,f"{model['robot']}  /  摆位与起始装液",25,MUTED)
    c.line(65,198,1935,198,INK,3)
    c.text(65,231,'A  摆位',32)
    c.text(65,282,'俯视 · 下方为正面',21,MUTED)
    slots = [[f'{r}{col}' for col in range(1,4)] for r in 'ABCD'] if model['robot'] == 'Flex' else [list(map(str,range(n,n+3))) for n in (10,7,4,1)]
    stacks = defaultdict(list)
    for m in model['modules']:
        stacks[m['slot']].append(MODULE_NAMES.get(m['model'],m['model']))
        if m['model'].startswith('thermocycler'):
            covered = ['A1','B1'] if model['robot']=='Flex' else ['7','8','10','11']
            for s in covered:
                if s!=m['slot']: stacks[s].append('PCR 模块占位')
    for item in model['labware']:
        stacks[item['slot']].append(item['name'])
    for s, name in model['waste'].items():
        stacks[s].append(name)
    for row, ss in enumerate(slots):
        for col, slot in enumerate(ss):
            x,y=65+205*col,333+137*row
            names=stacks.get(slot,[])
            c.rect(x,y,191,122,PALE if names else '#f7f9fa')
            c.text(x+12,y+8,slot,21,COLORS[0] if names else MUTED)
            for i,name in enumerate(names[:3]): c.text(x+12,y+41+i*24,name,18,width=168)
            # Tiny glyphs keep the overview recognizable even when names are long.
            if names:
                for a in range(3):
                    for b in range(5): c.circle(x+139+b*7,y+15+a*6,1.5,COLORS[0],COLORS[0],1)
    y=930
    c.text(65,y,'移液器',26)
    for i,p in enumerate(model['pipettes']):
        c.text(65,y+49+i*38,f"{'左' if p['mount']=='left' else '右'}  {p['name']}",21,width=590)
    y += 70 + len(model['pipettes'])*38
    extras=[(s,names) for s,names in stacks.items() if not any(s in ss for ss in slots)]
    for s,names in extras[:4]:
        c.text(65,y,f"{s} · {' / '.join(names)}",20,MUTED,width=590); y+=36
    c.text(65,y+30,'●  预装液体     ○  装液未声明',22,MUTED)
    c.text(65,y+72,'孔内编号对应试剂；0 为空孔。',20,MUTED)
    c.text(65,y+108,'完整名称与逐孔数据见配置页面。',20,MUTED)
    c.line(703,230,703,height-70)
    yy=231
    for i,item in enumerate(items):
        c.text(755,yy,f"{item['slot']}  /  {item['name']}",29,width=1160)
        c.text(755,yy+49,'起始装液 / μL',20,MUTED)
        draw_plate(c,model,item,800,yy+130,650,350)
        sy=yy+100
        for wells,mix in groups(item)[:8]:
            codes='/'.join(str(model['liquids'][key]['code']) for key in mix)
            c.text(1495,sy,f"{codes}  {', '.join(wells)}",21,COLORS[0],width=430)
            c.text(1495,sy+29,mix_label(model,mix),20,width=430)
            sy+=70
        if len(groups(item))>8: c.text(1495,sy,'更多装液 → 逐孔表',20,MUTED)
        if not item['initial']: c.text(1495,sy,'装液未声明',21,MUTED)
        yy+=card_heights[i]
        c.line(755,yy-17,1935,yy-17)
    if not items: c.text(755,260,'协议未加载液体载具',28,MUTED)
    c.line(65,height-58,1935,height-58)
    c.text(65,height-43,'LabscriptAI · Gao, Yuan et al. · bioRxiv 2025 · DOI: 10.1101/2025.09.30.679666',16,MUTED)
    if total>1:c.text(1935,height-43,f'{page} / {total}',18,MUTED,anchor='ra')
    c.image.save(out)


def generate(analysis_path, out_root):
    source=Path(analysis_path).read_bytes()
    digest=hashlib.sha256(source).hexdigest()
    # Include renderer and font identity: plugin updates cannot reuse old artwork.
    version=hashlib.sha256(Path(__file__).read_bytes()+FONT.read_bytes()).hexdigest()[:12]
    root=Path(out_root); root.mkdir(parents=True,exist_ok=True)
    target=root/f'{digest[:20]}-{version}'
    if (target/'manifest.json').is_file():
        manifest=json.loads((target/'manifest.json').read_text())
        if all((target/name).is_file() for name in manifest['files']): return {**manifest,'directory':str(target.resolve())}
        shutil.rmtree(target)
    model=build_model(json.loads(source))
    model['analysis_sha256']=digest
    plates=[v for v in model['labware'] if not v['adapter'] and not v['tiprack']]
    pages=[plates[n:n+2] for n in range(0,len(plates),2)] or [[]]
    stage=Path(tempfile.mkdtemp(prefix='.figure-',dir=root))
    try:
        images=[]
        for i,items in enumerate(pages,1):
            name='setup.png' if i==1 else f'setup-{i}.png'
            render_page(model,items,stage/name,i,len(pages));images.append(name)
        (stage/'setup.json').write_text(json.dumps(model,ensure_ascii=False,indent=2),encoding='utf-8')
        rows=[]
        for v in model['labware']:
            if v['adapter'] or v['tiprack']:continue
            for well in v['definition']['wells']:
                mix=v['initial'].get(well)
                state='已声明空孔' if mix is not None and sum(mix.values())==0 else '预装' if mix else '未声明'
                rows.append([v['slot'],v['name'],well,state,mix_label(model,mix) if mix else '',fmt(sum(mix.values())) if mix else ''])
        headings=['槽位','载具','孔位','起始状态','组分 / μL','总体积 / μL']
        with (stage/'wells.csv').open('w',encoding='utf-8-sig',newline='') as handle:
            writer=csv.writer(handle)
            # Spreadsheet formulas must remain literal reagent names.
            writer.writerows([["'"+s if str(s).startswith(('=','+','-','@')) else s for s in row] for row in [headings,*rows]])
        esc=lambda value:html.escape(str(value),quote=True)
        figures=''.join(f'<a href="{name}" target="_blank"><img src="{name}" alt="{esc(model["title"])}，摆位与起始装液，第{i}页"></a><p><a href="{name}" download>下载 PNG · {i}</a></p>' for i,name in enumerate(images,1))
        table='<table><thead><tr>'+''.join(f'<th>{esc(s)}</th>' for s in headings)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{esc(s)}</td>' for s in row)+'</tr>' for row in rows)+'</tbody></table>'
        byid={v['id']:v for v in model['labware']}
        paths=''.join(f'<li>{esc(byid[a]["slot"])} / {esc(byid[a]["name"])} → {esc(byid[b]["slot"])} / {esc(byid[b]["name"])}</li>' for a,b in model['routes'] if a in byid and b in byid)
        page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验配置图</title>
<style>body{font:16px/1.5 "Noto Sans SC","Microsoft YaHei","Heiti SC",sans-serif;color:#172f40;margin:24px auto;padding:0 20px;max-width:1500px}nav{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}a{color:#087c83}img{width:100%;height:auto;border:1px solid #dce5e9}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #dce5e9;overflow-wrap:anywhere}section{overflow:auto}h1{font-size:24px}</style>
<nav><a id="animation" hidden>返回模拟动画</a><a href="wells.csv" download>下载逐孔表 CSV</a><a href="setup.json" download>配置数据 JSON</a></nav>'''+figures+('<h1>移液路径</h1><ul>'+paths+'</ul>' if paths else '')+'<details><summary>逐孔装液表</summary><section>'+table+'</section></details><script>const m=location.pathname.match(/^\\/flex3d\\/([a-z0-9]+)\\//);if(m){const a=document.getElementById("animation");a.href="/viewer.html?key="+m[1];a.hidden=false}</script></html>'
        (stage/'setup.html').write_text(page,encoding='utf-8')
        manifest={'ok':True,'schema':SCHEMA,'analysis_sha256':digest,'state':'declared_initial',
                  'images':images,'files':[*images,'setup.html','setup.json','wells.csv'],
                  'labware_count':len(model['labware']),'source_well_count':sum(len(v['initial']) for v in model['labware'])}
        (stage/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
        try:stage.rename(target)
        except OSError:
            if not (target/'manifest.json').is_file():raise
        return {**manifest,'directory':str(target.resolve())}
    finally:
        if stage.exists():shutil.rmtree(stage)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analysis',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path)
    args=parser.parse_args()
    try:result=generate(args.analysis,args.out)
    except Exception as error:result={'ok':False,'error':'figure_generation_failed','message':str(error)}
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':main()
