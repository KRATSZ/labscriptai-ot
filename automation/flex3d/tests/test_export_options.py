"""Export regressions: complete preflight warnings and ranged video clips."""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sim.play_protocol import FRAME_H, FRAME_W, render_video

ROOT = Path(__file__).resolve().parents[3]
PREFLIGHT = ROOT / 'automation/flex3d/scripts/render_protocol_3d.py'


def parse_preflight(done):
    lines = done.stdout.strip().splitlines()
    if len(lines) != 1:
        raise AssertionError(f'expected one JSON line, got {len(lines)}:\n{done.stdout}\n{done.stderr}')
    return json.loads(lines[0])


class ExportOptions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.folder = Path(cls.tmp.name)
        cls.warning_source = cls.folder / 'many_warnings.py'
        cls.warning_source.write_text('''from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    rack = p.load_labware("opentrons_flex_96_tiprack_50ul", "A3")
    plate = p.load_labware("nest_96_wellplate_200ul_flat", "C3")
    pip = p.load_instrument("flex_8channel_50", "left", tip_racks=[rack])
    pip.pick_up_tip()
    for _ in range(135):
        pip.touch_tip(plate["A1"])
''', encoding='utf-8')
        cls.failure_source = cls.folder / 'liquid_failure.py'
        cls.failure_source.write_text('''from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    rack = p.load_labware("opentrons_flex_96_tiprack_50ul", "A3")
    plate = p.load_labware("nest_96_wellplate_200ul_flat", "C3")
    pip = p.load_instrument("flex_8channel_50", "left", tip_racks=[rack])
    pip.pick_up_tip()
    pip.touch_tip(plate["A1"])
    pip.aspirate(10, plate["A1"])
''', encoding='utf-8')
        cls.analysis = cls.folder / 'tiny.analysis.json'
        tiny = cls.folder / 'tiny.py'
        tiny.write_text('''from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    rack = p.load_labware("opentrons_flex_96_tiprack_50ul", "A3")
    pip = p.load_instrument("flex_8channel_50", "left", tip_racks=[rack])
    pip.pick_up_tip()
''', encoding='utf-8')
        done = subprocess.run(
            [sys.executable, '-m', 'opentrons.cli', 'analyze', '--json-output', str(cls.analysis), str(tiny)],
            capture_output=True, text=True,
        )
        if done.returncode != 0:
            raise AssertionError(done.stdout + done.stderr)

    def preflight(self, source, out):
        done = subprocess.run(
            [sys.executable, str(PREFLIGHT), str(source), '--out', str(out)],
            capture_output=True, text=True, timeout=600,
        )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return parse_preflight(done)

    def play(self, *args):
        env = os.environ.copy()
        env['PYTHONPATH'] = str(ROOT / 'automation/flex3d') + os.pathsep + env.get('PYTHONPATH', '')
        env['FLEX3D_EXPORT'] = str(self.folder / 'play-export')
        return subprocess.run(
            [sys.executable, '-m', 'sim.play_protocol', *map(str, args)],
            capture_output=True, text=True, timeout=180, env=env,
        )

    def test_preflight_reports_every_plan_warning_in_order_and_saves_same_list(self):
        out = self.folder / 'warnings-out'
        data = self.preflight(self.warning_source, out)
        expected = [f'command {n}: touchTip is shown as text only' for n in range(6, 141)]
        self.assertEqual(data['status'], 'passed')
        self.assertEqual(data['warnings_count'], 135)
        self.assertEqual(data['warnings'], expected)
        self.assertEqual(data['warnings_count'], len(data['warnings']))
        checks_file = next(Path(item['path']) for item in data['files'] if item['kind'] == 'checks')
        artifact = json.loads(checks_file.read_text(encoding='utf-8'))
        self.assertEqual(artifact['warnings'], data['warnings'])
        self.assertEqual(artifact['warnings_count'], data['warnings_count'])
        self.assertFalse(list(out.rglob('*.mp4')))
        self.assertEqual({item['kind'] for item in data['files']}, {'checks'})

    def test_preflight_early_missing_source_has_empty_warning_contract(self):
        data = self.preflight(self.folder / 'does-not-exist.py', self.folder / 'missing-out')
        self.assertEqual(data['error'], 'missing_source')
        self.assertEqual(data['warnings'], [])
        self.assertEqual(data['warnings_count'], 0)
        self.assertEqual(data['files'], [])

    def test_failed_check_keeps_all_warnings_first_liquid_failure_and_index(self):
        out = self.folder / 'failure-out'
        data = self.preflight(self.failure_source, out)
        warnings = data['warnings']
        self.assertEqual(data['status'], 'failed')
        self.assertEqual(data['failed_checks'], ['liquid'])
        self.assertEqual(data['warnings_count'], len(warnings))
        self.assertEqual(len(warnings), 9)
        self.assertEqual(warnings[0], 'command 6: touchTip is shown as text only')
        self.assertEqual(warnings[1], 'command 7: lw2 A1 holds 0.0 uL, asked for 10 uL')
        self.assertEqual(warnings[-1], 'command 7: lw2 H1 holds 0.0 uL, asked for 10 uL')
        liquid = next(item for item in data['checks'] if item['name'] == 'liquid')
        self.assertEqual(liquid['status'], 'fail')
        self.assertEqual(liquid['detail'], next(item for item in warnings if 'asked for' in item))
        self.assertEqual(liquid['command_index'], 6)
        checks_file = next(Path(item['path']) for item in data['files'] if item['kind'] == 'checks')
        artifact = json.loads(checks_file.read_text(encoding='utf-8'))
        self.assertEqual(artifact['warnings'], warnings)
        self.assertEqual(artifact['warnings_count'], data['warnings_count'])

    def test_scene_failure_preserves_warnings_built_before_the_failure(self):
        driver = """import runpy, sys
from unittest.mock import patch
sys.argv = sys.argv[1:]
with patch('sim.flex_scene.write_model', side_effect=RuntimeError('fixture scene failure')):
    runpy.run_path(sys.argv[0], run_name='__main__')
"""
        done = subprocess.run(
            [sys.executable, '-c', driver, str(PREFLIGHT), str(self.warning_source),
             '--out', str(self.folder / 'broken-scene')],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        data = parse_preflight(done)
        self.assertEqual(data['error'], 'scene_failed')
        self.assertFalse(data['ok'])
        self.assertEqual(data['warnings'], [f'command {n}: touchTip is shown as text only' for n in range(6, 141)])
        self.assertEqual(data['warnings_count'], 135)

    def test_range_flag_combinations_are_argparse_errors(self):
        missing = self.folder / 'no-source.json'
        cases = [
            (['--from', '1'], '--from/--to require --video'),
            (['--to', '1'], '--from/--to require --video'),
            (['--video', '--from', '1', '--frame', '2'], 'cannot be combined with --frame'),
            (['--video', '--to', '1', '--view'], 'cannot be combined with --view'),
            (['--video', '--fps', '0'], '--fps must be greater than zero'),
        ]
        for args, message in cases:
            with self.subTest(args=args):
                done = self.play(missing, *args)
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn(message, done.stderr)
                self.assertEqual(done.stdout, '')

    def test_semantic_range_errors_fail_before_rendering(self):
        cases = [
            (['--video', '--from', '-1'], '--from/--to must be nonnegative seconds'),
            (['--video', '--to', '-0.5'], '--from/--to must be nonnegative seconds'),
            (['--video', '--from', '2', '--to', '1'], '--from must be less than --to'),
            (['--video', '--from', 'nan'], '--from/--to must be finite seconds'),
            (['--video', '--to', 'inf'], '--from/--to must be finite seconds'),
            (['--video', '--to', '1e9'], '--to must not exceed the protocol duration'),
        ]
        for args, message in cases:
            with self.subTest(args=args):
                done = self.play(self.analysis, *args)
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn(message, done.stderr)
                self.assertEqual(done.stdout, '')

    def test_ranged_video_samples_exact_absolute_times(self):
        plan = SimpleNamespace(duration=10.0)
        renderer = FakeRenderer()
        proc = FakeProcess()
        with patch('sim.play_protocol.subprocess.Popen', return_value=proc):
            frames = render_video(plan, renderer, self.folder / 'clip.mp4', 4, 2.5, 4.0)
        self.assertEqual(frames, 6)
        self.assertEqual(renderer.times, [2.5, 2.75, 3.0, 3.25, 3.5, 3.75])
        self.assertTrue(all(2.5 <= t < 4.0 for t in renderer.times))
        self.assertEqual(proc.stdin.data, b'x' * frames)

    def test_single_omitted_range_bound_uses_zero_and_protocol_duration(self):
        plan = SimpleNamespace(duration=10.0)
        renderer = FakeRenderer()
        with patch('sim.play_protocol.subprocess.Popen', return_value=FakeProcess()):
            frames = render_video(plan, renderer, self.folder / 'start.mp4', 4, 2.5, None)
        self.assertEqual(frames, 30)
        self.assertEqual(renderer.times, [2.5 + i / 4 for i in range(30)])
        renderer = FakeRenderer()
        with patch('sim.play_protocol.subprocess.Popen', return_value=FakeProcess()):
            frames = render_video(plan, renderer, self.folder / 'end.mp4', 4, None, 4.0)
        self.assertEqual(frames, 16)
        self.assertEqual(renderer.times, [i / 4 for i in range(16)])

    def test_floating_point_boundary_does_not_add_a_frame_at_or_after_end(self):
        plan = SimpleNamespace(duration=2.0)
        renderer = FakeRenderer()
        with patch('sim.play_protocol.subprocess.Popen', return_value=FakeProcess()):
            frames = render_video(plan, renderer, self.folder / 'boundary.mp4', 30, 1.0, 1.1)
        self.assertEqual(frames, 3)
        self.assertEqual(renderer.times, [1.0, 1.0 + 1 / 30, 1.0 + 2 / 30])
        self.assertTrue(all(t < 1.1 for t in renderer.times))

    def test_default_whole_video_sample_sequence_is_unchanged(self):
        plan = SimpleNamespace(duration=2.0)
        renderer = FakeRenderer()
        with patch('sim.play_protocol.subprocess.Popen', return_value=FakeProcess()):
            frames = render_video(plan, renderer, self.folder / 'whole.mp4', 3)
        self.assertEqual(frames, 7)
        self.assertEqual(renderer.times, [min(i / 3, 2.0) for i in range(7)])

    def test_invalid_ranges_are_rejected_before_starting_ffmpeg(self):
        plan = SimpleNamespace(duration=10.0)
        cases = [
            (4, -1.0, 2.0),
            (4, 2.0, 1.0),
            (4, 2.0, 2.0),
            (4, math.nan, 2.0),
            (4, 1.0, math.inf),
            (4, 1.0, 10.01),
            (0, 1.0, 2.0),
            (-1, 1.0, 2.0),
        ]
        for fps, t0, t1 in cases:
            with self.subTest(fps=fps, t0=t0, t1=t1):
                with patch('sim.play_protocol.subprocess.Popen') as popen:
                    with self.assertRaises(ValueError):
                        render_video(plan, FakeRenderer(), self.folder / 'bad.mp4', fps, t0, t1)
                    popen.assert_not_called()

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe not installed')
    def test_tiny_mp4_has_the_requested_clip_frame_count(self):
        path = self.folder / 'tiny_clip.mp4'
        frames = render_video(SimpleNamespace(duration=5.0), RealRenderer(), path, 5, 1.0, 1.8)
        done = subprocess.run(
            ['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
             '-show_entries', 'stream=nb_read_frames', '-of', 'json', str(path)],
            capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(frames, 4)
        self.assertEqual(int(json.loads(done.stdout)['streams'][0]['nb_read_frames']), frames)


class FakeFrame:
    def tobytes(self):
        return b'x'


class FakeRenderer:
    def __init__(self):
        self.times = []
        self.focus = 'tip'

    def frame(self, t):
        self.times.append(t)
        return FakeFrame()


class FakeStdin:
    def __init__(self):
        self.data = b''
        self.closed = False

    def write(self, data):
        self.data += data

    def close(self):
        self.closed = True


class FakeProcess:
    def __init__(self):
        self.stdin = FakeStdin()
        self.returncode = None

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def poll(self):
        return self.returncode


class RealFrame:
    def tobytes(self):
        return bytes(FRAME_W * FRAME_H * 3)


class RealRenderer:
    def __init__(self):
        self.focus = 'tip'

    def frame(self, t):
        return RealFrame()


if __name__ == '__main__':
    unittest.main()
