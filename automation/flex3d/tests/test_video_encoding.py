"""GPU selection, runtime fallback, cleanup and real video export regressions."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from sim import video_encoding as video


class VideoEncoding(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"FLEX3D_VIDEO_ENCODER": "auto"})
        env.start()
        self.addCleanup(env.stop)
        self.renderer = SimpleNamespace(focus="tip")
        self.times = lambda: iter([1.0, 1.25, 1.5])

    def export(self):
        return video.encode_video(self.renderer, Path("clip.mp4"), 4, 64, 48, self.times)

    def test_nvenc_is_preferred_without_trying_amf_or_cpu(self):
        with patch.object(video, "_probe", return_value=(True, "")) as probe, \
                patch.object(video, "_write") as write:
            self.assertEqual(self.export(), "h264_nvenc")
        probe.assert_called_once_with("h264_nvenc", 64, 48, 4)
        self.assertEqual(write.call_args.args[-1], "h264_nvenc")

    def test_unavailable_nvenc_uses_amf_then_cpu(self):
        for amf_available, expected in ((True, "h264_amf"), (False, "libx264")):
            with self.subTest(amf_available=amf_available), \
                    patch.object(video, "_probe", side_effect=[(False, "driver missing"), (amf_available, "no device")]) as probe, \
                    patch.object(video, "_write") as write:
                self.assertEqual(self.export(), expected)
                self.assertEqual([call.args[0] for call in probe.call_args_list], ["h264_nvenc", "h264_amf"])
                self.assertEqual(write.call_args.args[-1], expected)

    def test_compiled_encoder_with_no_driver_is_rejected_by_real_probe(self):
        result = SimpleNamespace(returncode=1, stderr=b"Cannot load nvEncodeAPI64.dll\nother errors")
        with patch.object(video.subprocess, "run", return_value=result) as run:
            ok, error = video._probe("h264_nvenc", 64, 48, 4)
        self.assertFalse(ok)
        self.assertIn("nvEncodeAPI64.dll", error)
        command = run.call_args.args[0]
        self.assertIn("64x48", command)
        self.assertIn("h264_nvenc", command)
        self.assertEqual(len(run.call_args.kwargs["input"]), 64 * 48 * 3)
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_probe_timeout_falls_back_and_missing_ffmpeg_is_actionable(self):
        with patch.object(video.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 15)):
            ok, error = video._probe("h264_nvenc", 64, 48, 4)
            self.assertFalse(ok)
            self.assertIn("timed out", error)
        with patch.object(video.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(RuntimeError, "ffmpeg on PATH"):
                video._probe("h264_nvenc", 64, 48, 4)

    def test_cpu_override_skips_gpu_probes(self):
        with patch.dict(os.environ, {"FLEX3D_VIDEO_ENCODER": "libx264"}), \
                patch.object(video, "_probe") as probe, patch.object(video, "_write") as write:
            self.assertEqual(self.export(), "libx264")
        probe.assert_not_called()
        self.assertEqual(write.call_args.args[-1], "libx264")

    def test_explicit_hardware_override_falls_back_to_cpu(self):
        with patch.dict(os.environ, {"FLEX3D_VIDEO_ENCODER": "h264_amf"}), \
                patch.object(video, "_probe", return_value=(False, "driver unavailable")) as probe, \
                patch.object(video, "_write"):
            self.assertEqual(self.export(), "libx264")
        probe.assert_called_once_with("h264_amf", 64, 48, 4)

    def test_invalid_configuration_fails_before_starting_ffmpeg(self):
        with patch.dict(os.environ, {"FLEX3D_VIDEO_ENCODER": "typo"}), \
                patch.object(video.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(ValueError, "FLEX3D_VIDEO_ENCODER"):
                self.export()
        popen.assert_not_called()

    def test_flex_and_ot2_export_paths_use_the_shared_gpu_encoder(self):
        from sim.play_protocol import render_video as flex_video
        from sim.ot2_runtime.play_protocol import render_video as legacy_video
        from sim.ot2_runtime.play_ot2_protocol import render_video as ot2_video

        for render_video in (flex_video, legacy_video, ot2_video):
            with self.subTest(entry=render_video.__module__):
                proc = self.process(code=0)
                self.renderer.frame = Mock(return_value=SimpleNamespace(tobytes=lambda: b"rgb"))
                with patch.object(video, "_probe", return_value=(True, "")) as probe, \
                        patch.object(video.subprocess, "Popen", return_value=proc):
                    frames = render_video(SimpleNamespace(duration=0.5), self.renderer, Path("clip.mp4"), 4)
                self.assertEqual(frames, 3)
                self.assertEqual(self.renderer.video_encoder, "h264_nvenc")
                self.assertEqual([call.args[0] for call in self.renderer.frame.call_args_list], [0.0, 0.25, 0.5])
                probe.assert_called_once_with("h264_nvenc", 1440, 810, 4)

    def test_runtime_gpu_failure_replays_all_times_and_resets_camera_focus(self):
        failed = self.process(code=1)
        good = self.process(code=0)
        frame = SimpleNamespace(tobytes=lambda: bytes(64 * 48 * 3))
        samples = []

        def render(t):
            samples.append((t, self.renderer.focus))
            self.renderer.focus = "tracking"
            return frame

        self.renderer.frame = render
        with patch.dict(os.environ, {"FLEX3D_VIDEO_ENCODER": "h264_nvenc"}), \
                patch.object(video, "_probe", return_value=(True, "")), \
                patch.object(video.subprocess, "Popen", side_effect=[failed, good]) as popen:
            self.assertEqual(self.export(), "libx264")
        self.assertEqual(samples, [(1.0, None), (1.25, "tracking"), (1.5, "tracking")] * 2)
        self.assertIn("h264_nvenc", popen.call_args_list[0].args[0])
        self.assertIn("libx264", popen.call_args_list[1].args[0])
        self.assertEqual(failed.stdin.write.call_count, 3)
        self.assertEqual(good.stdin.write.call_count, 3)

    def test_broken_pipe_never_reports_a_partial_video_as_success(self):
        proc = self.process(code=0)
        proc.stdin.write.side_effect = BrokenPipeError
        self.renderer.frame = lambda t: SimpleNamespace(tobytes=lambda: b"rgb")
        with patch.dict(os.environ, {"FLEX3D_VIDEO_ENCODER": "libx264"}), \
                patch.object(video.subprocess, "Popen", return_value=proc):
            with self.assertRaises(video.EncoderError):
                self.export()

    def test_rendering_error_is_preserved_and_stops_ffmpeg(self):
        proc = self.process(code=0, running=True)
        self.renderer.frame = Mock(side_effect=ValueError("bad scene"))
        with patch.object(video, "_probe", return_value=(True, "")), \
                patch.object(video.subprocess, "Popen", return_value=proc) as popen:
            with self.assertRaisesRegex(ValueError, "bad scene"):
                self.export()
        self.assertEqual(popen.call_count, 1)
        proc.terminate.assert_called_once()
        proc.wait.assert_called_once_with(timeout=5)

    @staticmethod
    def process(code, running=False):
        proc = Mock()
        proc.stdin.closed = False
        proc.wait.return_value = code
        proc.poll.return_value = None if running else code
        return proc

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_auto_export_produces_a_decodable_video_with_all_frames(self):
        self.renderer.frame = lambda t: SimpleNamespace(tobytes=lambda: bytes(64 * 48 * 3))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "clip.mp4"
            selected = video.encode_video(self.renderer, path, 4, 64, 48, self.times)
            self.assertIn(selected, video.ENCODERS)
            decoded = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                capture_output=True, timeout=30,
            )
            self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors="replace"))
            self.assertEqual(len(decoded.stdout), 64 * 48 * 3 * 3)


if __name__ == "__main__":
    unittest.main()
