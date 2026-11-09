"""Declared setup presentation must not turn missing content into empty or final state."""
import copy
import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('experiment_figure', ROOT/'automation/figures/experiment_figure.py')
figure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(figure)


def fixture():
    wells={f'{r}{col}':{'x':14+9*(col-1),'y':74-9*i,'shape':'circular','diameter':6}
           for i,r in enumerate('ABCDEFGH') for col in range(1,13)}
    definition={'wells':wells,'parameters':{'isTiprack':False},'metadata':{'displayName':'孔板'}}
    return {'robotType':'OT-3 Standard','metadata':{'protocolName':'中文试剂摆位'},'errors':[],
            'liquids':[{'id':'sample','displayName':'独立样品甲 1 mM'}],
            'commands':[
                {'commandType':'loadModule','params':{'model':'temperatureModuleV2','location':{'slotName':'C1'}},'result':{'moduleId':'m'}},
                {'commandType':'loadLabware','params':{'location':{'moduleId':'m'},'loadName':'adapter'},'result':{'labwareId':'adapter','definition':{'wells':{},'parameters':{},'metadata':{}}}},
                {'commandType':'loadLabware','params':{'location':{'labwareId':'adapter'},'loadName':'plate','displayName':'冷源板'},'result':{'labwareId':'p','definition':definition}},
                {'commandType':'loadLiquid','params':{'labwareId':'p','liquidId':'sample','volumeByWell':{'A10':300,'B1':240}}},
                {'commandType':'moveToAddressableAreaForDropTip','params':{'addressableAreaName':'movableTrashA3'}}]}


class ExperimentFigure(unittest.TestCase):
    def test_nested_placement_identity_and_unknowns_are_preserved(self):
        model=figure.build_model(fixture())
        plate=model['labware'][1]
        self.assertEqual(plate['slot'],'C1')
        self.assertEqual(plate['initial']['A10'],{'sample':300})
        self.assertNotIn('A1',plate['initial'])
        self.assertEqual(model['state'],'declared_initial')
        self.assertEqual(model['waste'],{'A3':'垃圾桶'})
        self.assertTrue(model['labware'][0]['adapter'])
        self.assertNotIn('concentration',plate)

    def test_fail_closed_for_invalid_analysis_and_volume(self):
        for change in ({'robotType':'alien'}, {'errors':[{'detail':'failed'}]}, {'config':{'robotType':'OT-2'}}):
            raw=fixture();raw.update(change)
            with self.assertRaises(ValueError):figure.build_model(raw)
        for volume in (float('nan'),-1,True):
            raw=fixture();raw['commands'][3]['params']['volumeByWell']['A10']=volume
            with self.assertRaises(ValueError):figure.build_model(raw)
        raw=fixture();raw['commands'][3]['params']['volumeByWell']={'Z99':5}
        with self.assertRaises(ValueError):figure.build_model(raw)

    def test_declarations_replace_instead_of_inventing_a_mixture_and_zero_is_explicit(self):
        raw=fixture();raw['liquids'].append({'id':'other','displayName':'缓冲液'})
        raw['commands'].append({'commandType':'loadLiquid','params':{'labwareId':'p','liquidId':'other','volumeByWell':{'A10':0}}})
        plate=figure.build_model(raw)['labware'][1]
        self.assertEqual(plate['initial']['A10'],{'other':0})
        self.assertNotIn('A1',plate['initial'])

    def test_ot2_placement_and_late_loads_are_not_fabricated_as_initial(self):
        raw=fixture();raw['robotType']='OT-2 Standard'
        raw['commands'][0]['params']['location']={'slotName':'7'}
        raw['commands'][0]['params']['model']='thermocyclerModuleV2'
        self.assertEqual(figure.build_model(raw)['labware'][1]['slot'],'7')
        raw['commands'].insert(3,{'commandType':'aspirate','params':{'labwareId':'p','pipetteId':'pip'}})
        with self.assertRaisesRegex(ValueError,'after transfers'):figure.build_model(raw)

    def test_export_all_wells_pagination_html_escaping_and_content_cache(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);source=root/'analysis.json'
            raw=fixture();raw['liquids'][0]['displayName']='=样品<script>alert(1)</script>'
            second=copy.deepcopy(raw['commands'][2]);second['result']['labwareId']='second';second['params']['location']={'slotName':'C3'}
            third=copy.deepcopy(second);third['result']['labwareId']='third';third['params']['location']={'slotName':'D1'}
            raw['commands'] += [second,third]
            source.write_text(json.dumps(raw),encoding='utf-8')
            result=figure.generate(source,root/'out');folder=Path(result['directory'])
            self.assertEqual(len(result['images']),2)
            with Image.open(folder/'setup.png') as im:self.assertEqual(im.width,2000)
            page=(folder/'setup.html').read_text()
            self.assertIn('&lt;script&gt;',page)
            self.assertNotIn('<script>alert(1)',page)
            self.assertNotIn('设计预览',page)
            with (folder/'wells.csv').open(encoding='utf-8-sig') as handle:
                rows=list(csv.reader(handle))
            self.assertEqual(len(rows),1+96*3)
            self.assertEqual(next(row for row in rows if row[2]=='A10')[5],'300')
            self.assertTrue(next(row for row in rows if row[2]=='A10')[4].startswith("'="))
            again=figure.generate(source,root/'out');self.assertEqual(again['directory'],result['directory'])
            (folder/'setup.png').unlink()
            figure.generate(source,root/'out')
            self.assertTrue((folder/'setup.png').is_file())
            raw['commands'][3]['params']['volumeByWell']['A10']=301
            source.write_text(json.dumps(raw),encoding='utf-8')
            self.assertNotEqual(figure.generate(source,root/'out')['directory'],result['directory'])


if __name__=='__main__':unittest.main()
