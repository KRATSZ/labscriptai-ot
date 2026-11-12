"""Shared liquid identities for setup figures and playback; no robot/3D imports.

Inferred sources have no starting quantity. Command volumes below are used only
to decide when a missing source annotation is needed, never as initial inventory.
Gao, Yuan et al., bioRxiv 2025, DOI: 10.1101/2025.09.30.679666.
"""
import colorsys
import math


class LiquidAnnotations:
    def __init__(self, raw):
        self.liquids = {}
        self.sources = {}
        self._index = 0
        self._reserved_names = {v.get('displayName') for v in raw.get('liquids',[]) if v.get('displayName')}
        for item in raw.get('liquids', []):
            self.declared(item['id'], item.get('displayName'), item.get('displayColor'))
        for cmd in raw.get('commands', []):
            if cmd.get('commandType') == 'loadLiquid':
                self.declared(cmd['params']['liquidId'])
        self._find_sources(raw.get('commands', []))

    def _unknown(self, key, origin, source=None):
        self._index += 1
        while f'未知液体{self._index}' in self._reserved_names:
            self._index += 1
        rgb = colorsys.hsv_to_rgb((0.56 + (self._index-1)*0.381966) % 1, 0.58, 0.72)
        color = '#' + ''.join(f'{round(v*255):02x}' for v in rgb)
        value = {'id': key, 'name': f'未知液体{self._index}', 'color': color,
                 'unknown_index': self._index, 'origin': origin}
        if source is not None:
            value['source'] = {'labware_id': source[0], 'well': source[1]}
        self.liquids[key] = value
        return key

    def declared(self, key, name=None, color=None):
        if key not in self.liquids:
            if name and name.strip():
                self.liquids[key] = {'id': key, 'name': name, 'color': color or '#3C78D8', 'origin': 'declared'}
            else:
                self._unknown(key, 'declared')
                if color:
                    self.liquids[key]['color'] = color
        return key

    def source(self, labware_id, well):
        where = (labware_id, well)
        if where not in self.sources:
            key = f'__unknown_source__:{labware_id}:{well}'
            while key in self.liquids:
                key += '_'
            self.sources[where] = self._unknown(key, 'operation_inferred', where)
        return self.sources[where]

    @staticmethod
    def target_wells(definition, name, channels):
        wells = definition.get('wells', {})
        if name not in wells:
            return []
        if channels == 1 or 'centerMultichannelOnWells' in definition.get('parameters', {}).get('quirks', []):
            return [name]*channels
        anchor = wells[name]
        return [next((n for n,w in wells.items() if abs(w['x']-anchor['x']) < .1
                      and abs(w['y']-(anchor['y']-9*i)) < .1), None) for i in range(channels)]

    def _find_sources(self, commands):
        definitions, channels, targets, tips, balances, declared = {}, {}, {}, {}, {}, set()
        for cmd in commands:
            if cmd.get('status') not in (None, 'succeeded'):
                continue
            kind, p = cmd.get('commandType'), cmd.get('params', {})
            result = cmd.get('result') or {}
            tool = p.get('pipetteId')
            if kind == 'loadLabware':
                definitions[result['labwareId']] = result.get('definition', {})
            elif kind == 'loadPipette':
                channels[result['pipetteId']] = 8 if 'multi' in p['pipetteName'] else 1
            elif kind == 'loadLiquid':
                for well, volume in p['volumeByWell'].items():
                    where = (p['labwareId'], well)
                    declared.add(where)
                    balances[where] = float(volume)
            if kind == 'pickUpTip' or kind.startswith('dropTip'):
                tips[tool] = [[] for _ in range(channels.get(tool, 1))]
                targets.pop(tool, None)
            elif kind in ('moveToAddressableArea', 'moveToAddressableAreaForDropTip', 'home'):
                if kind == 'home':
                    targets.clear()
                else:
                    targets.pop(tool, None)
            elif kind in ('moveToWell', 'aspirate', 'dispense', 'blowout'):
                targets[tool] = (p.get('labwareId'), p.get('wellName'), p.get('wellLocation', {}))
            if kind not in ('aspirate', 'aspirateInPlace', 'dispense', 'dispenseInPlace',
                            'blowout', 'blowOutInPlace', 'airGap', 'airGapInPlace'):
                continue
            amount = p.get('volume')
            if amount is not None and (not isinstance(amount, (int,float)) or not math.isfinite(amount) or amount < 0):
                continue
            lw, name, location = targets.get(tool, (None,None,{}))
            definition = definitions.get(lw, {})
            names = self.target_wells(definition, name, channels.get(tool,1))
            stacks = tips.setdefault(tool, [[] for _ in range(channels.get(tool,1))])
            depth = definition.get('wells',{}).get(name,{}).get('depth',0.)
            z = {'bottom':0.,'center':depth/2,'top':depth}.get(location.get('origin','bottom'),0.) + location.get('offset',{}).get('z',0.)
            air = kind.startswith('airGap') or z > depth + 1e-6
            for i,stack in enumerate(stacks):
                well = names[i] if i < len(names) else None
                where = (lw,well) if well is not None else None
                if kind in ('aspirate','aspirateInPlace','airGap','airGapInPlace'):
                    value = float(amount or 0)
                    liquid = where is not None and not air and value > 0
                    if liquid:
                        available = balances.get(where,0.)
                        if available + 1e-6 < value and where not in declared:
                            self.source(*where)
                            available = value
                        taken = min(value,available)
                        balances[where] = max(0.,available-taken)
                        stack.append([taken,True])
                    else:
                        stack.append([value,False])
                else:
                    remaining = float(amount) if amount is not None else sum(v for v,_ in stack)
                    deposited = 0.
                    while stack and remaining > 1e-9:
                        value,liquid = stack[-1]
                        take = min(value,remaining)
                        deposited += take if liquid else 0.
                        remaining -= take
                        stack[-1][0] -= take
                        if stack[-1][0] < 1e-9:
                            stack.pop()
                    if where is not None:
                        balances[where] = balances.get(where,0.)+deposited
