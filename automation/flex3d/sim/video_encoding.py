"""GPU-first H.264 export shared by the Flex and OT-2 renderers.

Hardware is tested with real RGB input, not merely FFmpeg's compiled encoder
list. NVENC is preferred over AMF; Intel integrated Quick Sync is not selected.
OpenGL scene rendering remains independent of this video encoder selection.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Callable, Iterable


ENCODERS = {
    "h264_nvenc": ("-preset", "p4", "-rc", "vbr", "-cq", "20", "-b:v", "0"),
    "h264_amf": ("-quality", "speed", "-rc", "cqp", "-qp_i", "20", "-qp_p", "20"),
    "libx264": ("-crf", "20", "-preset", "medium"),
}


class EncoderError(RuntimeError):
    """An FFmpeg failure, distinct from a scene rendering exception."""


def _input(width: int, height: int, fps: int) -> list[str]:
    return [
        "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
        "-r", str(fps), "-i", "pipe:0",
    ]


def _output(encoder: str) -> list[str]:
    return ["-c:v", encoder, *ENCODERS[encoder], "-pix_fmt", "yuv420p"]


def _process_options() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _probe(encoder: str, width: int, height: int, fps: int) -> tuple[bool, str]:
    try:
        done = subprocess.run(
            [*_input(width, height, fps), "-frames:v", "1", *_output(encoder), "-f", "null", "-"],
            input=bytes(width * height * 3), stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, timeout=15, **_process_options(),
        )
    except FileNotFoundError as exc:
        raise RuntimeError("Video export requires ffmpeg on PATH") from exc
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    error = done.stderr.decode("utf-8", errors="replace").strip()
    return done.returncode == 0, error.splitlines()[0][:400] if error else f"exit {done.returncode}"


def _write(renderer, path: Path, fps: int, width: int, height: int,
           times: Callable[[], Iterable[float]], encoder: str) -> None:
    # FFmpeg may emit more than a pipe buffer of diagnostics. A file avoids
    # deadlocking the RGB input and retains the error if a driver fails later.
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(
            [*_input(width, height, fps), *_output(encoder), "-movflags", "+faststart", str(path)],
            stdin=subprocess.PIPE, stderr=errors, **_process_options(),
        )
        try:
            renderer.focus = None
            broken_pipe = False
            try:
                for t in times():
                    proc.stdin.write(renderer.frame(t).tobytes())
                proc.stdin.close()
            except BrokenPipeError:
                broken_pipe = True
            code = proc.wait()
            if code != 0 or broken_pipe:
                errors.seek(0)
                detail = errors.read().decode("utf-8", errors="replace")[-4000:].strip()
                raise EncoderError(f"{encoder} failed (exit {code}): {detail}")
        finally:
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


def encode_video(renderer, path: Path, fps: int, width: int, height: int,
                 times: Callable[[], Iterable[float]]) -> str:
    """Stream frames to a tested GPU encoder, retrying with CPU on failure.

    ``times`` must produce a fresh iterator for every attempt. Resetting focus
    and replaying from the first frame preserves both clip timing and tracking.
    No raw frame cache or robot connection is needed.
    """
    requested = os.environ.get("FLEX3D_VIDEO_ENCODER", "auto").strip().lower()
    if requested not in ("auto", *ENCODERS):
        raise ValueError("FLEX3D_VIDEO_ENCODER must be auto, h264_nvenc, h264_amf or libx264")
    candidates = list(ENCODERS) if requested == "auto" else [requested]
    if "libx264" not in candidates:
        candidates.append("libx264")
    for encoder in candidates:
        if encoder != "libx264":
            ok, reason = _probe(encoder, width, height, fps)
            if not ok:
                print(f"Video encoder: {encoder} unavailable; {reason}", file=sys.stderr)
                continue
        print(f"Video encoder: {encoder}", file=sys.stderr)
        try:
            _write(renderer, path, fps, width, height, times, encoder)
            return encoder
        except EncoderError as exc:
            if encoder == "libx264":
                raise
            print(f"Video encoder: retrying after {exc}", file=sys.stderr)
    raise RuntimeError("No video encoder available")
