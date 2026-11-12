"""Unknown identity is visible and traceable without inventing initial inventory."""
import copy
import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'automation/flex3d'))
sys.path.insert(0, str(ROOT/'automation/figures'))

from liquid_annotations import LiquidAnnotations
from experiment_figure import build_model, generate
from sim.machines import machine_for


class UnknownLiquids(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        cls.raw = {}
        for robot in ('Flex','OT-2'):
            for multi in (False,True):
                key = (robot,multi)
                name = f'{robot}-{multi}'
                source = cls.folder/f'{name}.py'
                source.write_text('''from opentrons import protocol_api
requirements = {"robotType": ROBOT, "apiLevel": "2.20"}
def run(p):
    rack = p.load_labware(RACK, RACK_SLOT)
    src = p.load_labware("nest_12_reservoir_15ml", SOURCE_SLOT)
    dst = p.load_labware("nest_96_wellplate_200ul_flat", DEST_SLOT)
    pip = p.load_instrument(PIPETTE, "left", tip_racks=[rack])
    pip.pick_up_tip()
    pip.aspirate(10, src["A1"])
    pip.dispense(10, dst["A1"])
    pip.mix(2, 5, dst["A1"])
    pip.aspirate(10, src["A1"])
    pip.dispense(10, dst["A2"])
    pip.aspirate(10, src["A2"])
    pip.dispense(10, dst["A3"])
'''.replace('ROBOT',repr(robot)).replace('RACK_SLOT',repr('A1' if robot=='Flex' else '1'))
                    .replace('SOURCE_SLOT',repr('B2' if robot=='Flex' else '2'))
                    .replace('DEST_SLOT',repr('C2' if robot=='Flex' else '3'))
                    .replace('RACK',repr('opentrons_flex_96_tiprack_50ul' if robot=='Flex' else 'opentrons_96_tiprack_20ul'))
                    .replace('PIPETTE',repr(('flex_8channel_50' if multi else 'flex_1channel_50') if robot=='Flex' else ('p20_multi_gen2' if multi else 'p20_single_gen2'))), encoding='utf-8')
                analysis = cls.folder/f'{name}.json'
                python = sys.executable if robot=='Flex' else os.environ.get('OPENTRONS_OT2_PYTHON', str(ROOT/'.venv-ot2/Scripts/python.exe'))
                done = subprocess.run([python,'-X','utf8','-m','opentrons.cli','analyze','--check','--json-output',str(analysis),str(source)],capture_output=True,text=True,encoding='utf-8',timeout=60)
                if done.returncode:
                    raise AssertionError(done.stdout+done.stderr)
                cls.raw[key] = json.loads(analysis.read_text(encoding='utf-8'))

    def planned(self, raw, robot):
        path = self.folder/'current.json'
        path.write_text(json.dumps(raw),encoding='utf-8')
        machine = machine_for(raw['robotType'])
        run = machine.load_analysis(path,machine.load_deck())
        return machine, machine.plan(run)

    def test_source_identity_survives_repeat_transfers_and_mixing(self):
        for (robot,multi),raw in self.raw.items():
            with self.subTest(robot=robot,multi=multi):
                _,plan = self.planned(raw,robot)
                ann = plan.run.annotations
                self.assertEqual(len(ann.sources),2)
                self.assertEqual([v['name'] for v in ann.liquids.values()],['未知液体1','未知液体2'])
                self.assertEqual(len(plan.keys[0].state.wells),0)
                self.assertEqual(len(plan.keys[0].state.unknown_sources),2)
                dest = next(lw for lw in plan.run.labware.values() if lw.load_name=='nest_96_wellplate_200ul_flat')
                source = next(lw for lw in plan.run.labware.values() if lw.load_name=='nest_12_reservoir_15ml')
                for row in 'ABCDEFGH' if multi else 'A':
                    for col,lid in [(1,ann.sources[(source.id,'A1')]),(2,ann.sources[(source.id,'A1')]),(3,ann.sources[(source.id,'A2')])]:
                        self.assertEqual(plan.keys[-1].state.wells[(dest.key,f'{row}{col}')],{lid:10.})
                model = build_model(raw)
                self.assertEqual(model['labware'][1]['initial'],{})
                self.assertEqual(model['labware'][1]['inferred_initial'],{'A1':ann.sources[(source.id,'A1')],'A2':ann.sources[(source.id,'A2')]})
                self.assertEqual(model['labware'][2]['inferred_initial'],{})
                self.assertEqual([v['name'] for v in model['liquids'].values()],['未知液体1','未知液体2'])

    def with_inventory(self, raw, volume, name='Water'):
        raw=copy.deepcopy(raw)
        src=next(c for c in raw['commands'] if c['commandType']=='loadLabware' and c['params']['loadName']=='nest_12_reservoir_15ml')
        raw['liquids']=[{'id':'declared','displayName':name,'displayColor':'#3399cc'}]
        index=next(i for i,c in enumerate(raw['commands']) if c['commandType']=='pickUpTip')
        raw['commands'].insert(index,{'commandType':'loadLiquid','params':{'labwareId':src['result']['labwareId'],'liquidId':'declared','volumeByWell':{'A1':volume}},'result':{}})
        return raw

    def test_explicit_zero_and_underflow_are_never_replenished(self):
        for robot in ('Flex','OT-2'):
            for volume in (0,5):
                raw=self.with_inventory(self.raw[(robot,False)],volume)
                ann=LiquidAnnotations(raw)
                source_id=next(c['result']['labwareId'] for c in raw['commands'] if c['commandType']=='loadLabware' and c['params']['loadName']=='nest_12_reservoir_15ml')
                self.assertNotIn((source_id,'A1'),ann.sources)
                if robot=='OT-2':
                    with self.assertRaisesRegex(RuntimeError,'cannot aspirate'):
                        self.planned(raw,robot)
                else:
                    _,plan=self.planned(raw,robot)
                    self.assertTrue(any('asked for' in w for w in plan.warnings))
                    src=next(lw for lw in plan.run.labware.values() if lw.load_name=='nest_12_reservoir_15ml')
                    self.assertNotIn((src.key,'A1'),plan.keys[-1].state.unknown_sources)

    def test_unnamed_declared_liquid_keeps_its_known_quantity(self):
        for robot in ('Flex','OT-2'):
            raw=self.with_inventory(self.raw[(robot,False)],100,'  ')
            _,plan=self.planned(raw,robot)
            self.assertEqual(plan.run.liquids['declared'].name,'未知液体1')
            src=next(lw for lw in plan.run.labware.values() if lw.load_name=='nest_12_reservoir_15ml')
            self.assertEqual(plan.keys[-1].state.wells[(src.key,'A1')],{'declared':80})
            self.assertNotIn((src.key,'A1'),plan.keys[-1].state.unknown_sources)
            model=build_model(raw)
            self.assertEqual(model['labware'][1]['initial']['A1'],{'declared':100})

    def test_exports_distinguish_inferred_sources_from_declared_amounts(self):
        source=self.folder/'export.json'
        source.write_text(json.dumps(self.raw[('Flex',False)]),encoding='utf-8')
        result=generate(source,self.folder/'figures')
        folder=Path(result['directory'])
        with (folder/'wells.csv').open(encoding='utf-8-sig') as handle:
            rows=list(csv.reader(handle))
        unknown=[row for row in rows if '推断来源' in row[3]]
        self.assertEqual(len(unknown),2)
        self.assertEqual([row[4] for row in unknown],['未知液体1','未知液体2'])
        self.assertTrue(all(row[5]=='' for row in unknown))
        self.assertIn('起始量未声明', (folder/'setup.html').read_text(encoding='utf-8'))

    def test_scene_and_browser_payload_show_unknown_sources_and_transferred_liquid(self):
        import mujoco
        from sim.web_player import Model
        for robot in ('Flex','OT-2'):
            raw=self.raw[(robot,False)]
            source=self.folder/f'{robot}-view.json'
            source.write_text(json.dumps(raw),encoding='utf-8')
            folder=self.folder/f'{robot}-view';folder.mkdir(exist_ok=True)
            model=Model('unknown',source,folder)
            self.addCleanup(model.close)
            self.assertEqual([v['name'] for v in model.info()['liquids']],['未知液体1','未知液体2'])
            self.assertTrue(all(v['source_label'] for v in model.info()['liquids']))
            for time in (0.,model.plan.duration):
                model.scene.at(time)
                for where in model.plan.keys[0].state.unknown_sources:
                    gid=mujoco.mj_name2id(model.scene.model,mujoco.mjtObj.mjOBJ_GEOM,f'{where[0]}_liquid_{where[1]}')
                    self.assertGreater(model.scene.model.geom_rgba[gid,3],.1)
            dest=next(lw for lw in model.plan.run.labware.values() if lw.load_name=='nest_96_wellplate_200ul_flat')
            for well in ('A1','A2','A3'):
                gid=mujoco.mj_name2id(model.scene.model,mujoco.mjtObj.mjOBJ_GEOM,f'{dest.key}_liquid_{well}')
                self.assertGreater(model.scene.model.geom_rgba[gid,3],.1)
            aspirated=next(key for key in model.plan.keys if key.phase=='aspirate')
            model.scene.apply(aspirated.q,aspirated.state)
            tip_alpha=[model.scene.model.geom_rgba[i,3] for i in range(model.scene.model.ngeom)
                       if 'tip' in (model.scene.model.geom(i).name or '') and (model.scene.model.geom(i).name or '').endswith('_liquid')]
            self.assertTrue(any(alpha>.1 for alpha in tip_alpha))
            view=json.loads(model.view_path.read_text(encoding='utf-8'))
            self.assertTrue(view['frames'])
            # Inferred quantities must not become verified remaining amounts/ratios.
            from sim.play_protocol import check_liquid as flex_report
            from sim.ot2_runtime.play_ot2_protocol import check_liquid as ot2_report
            report=(flex_report if robot=='Flex' else ot2_report)(model.plan)
            entries=[entry for wells in report.values() for entry in wells.values()]
            self.assertTrue(entries)
            self.assertTrue(all(entry.get('actual_volume_uL') is None and entry['composition'] is None for entry in entries))


class AnnotationEdges(unittest.TestCase):
    def raw(self):
        wells={f'{r}1':{'x':10,'y':80-9*i,'depth':10} for i,r in enumerate('ABCDEFGH')}
        return {'commands':[
            {'commandType':'loadLabware','params':{},'result':{'labwareId':'source','definition':{'wells':wells}}},
            {'commandType':'loadPipette','params':{'pipetteName':'p20_multi_gen2'},'result':{'pipetteId':'pip'}},
            {'commandType':'aspirate','params':{'pipetteId':'pip','labwareId':'source','wellName':'A1','volume':10}}]}

    def test_multichannel_plate_has_separate_stable_source_identities(self):
        raw=self.raw()
        ann=LiquidAnnotations(raw)
        self.assertEqual(len(ann.sources),8)
        self.assertEqual(len(set(ann.sources.values())),8)
        self.assertEqual(ann.liquids,LiquidAnnotations(copy.deepcopy(raw)).liquids)
        raw['commands'] += [copy.deepcopy(raw['commands'][-1])]
        self.assertEqual(ann.sources,LiquidAnnotations(raw).sources)

    def test_air_and_unused_wells_do_not_gain_liquid_annotations(self):
        for origin,offset in [('top',1),('bottom',11),('center',6)]:
            raw=self.raw()
            raw['commands'][-1]['params']['wellLocation']={'origin':origin,'offset':{'z':offset}}
            self.assertFalse(LiquidAnnotations(raw).sources)
        raw=self.raw();raw['commands'][-1]['commandType']='airGap'
        self.assertFalse(LiquidAnnotations(raw).sources)
        raw=self.raw();raw['commands'].pop()
        self.assertFalse(LiquidAnnotations(raw).sources)

    def test_generated_unknown_names_do_not_collide_with_declared_names(self):
        raw=self.raw();raw['liquids']=[{'id':'named','displayName':'未知液体1'}]
        ann=LiquidAnnotations(raw)
        self.assertEqual(ann.liquids[ann.sources[('source','A1')]]['name'],'未知液体2')


if __name__=='__main__':
    unittest.main()
