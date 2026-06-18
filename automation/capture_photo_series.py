#!/usr/bin/env python3
"""
Timed deck-camera capture for layout variation datasets.

Reads robot IP from automation/.env, saves JPEGs under automation/photo/,
and waits between shots so you can rearrange labware on the deck.

Usage (from repo root):
  python automation/capture_photo_series.py
  python automation/capture_photo_series.py --count 30 --interval 10
  python automation/capture_photo_series.py --robot 192.168.66.102 --out automation/photo

Press Ctrl+C to stop early; manifest.json is updated after each capture.
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ENV = SCRIPT_DIR / ".env"
DEFAULT_OUT = SCRIPT_DIR / "photo"
OPENTRONS_VERSION = "4"


def load_robot_ip(env_path: Path) -> str:
    if not env_path.is_file():
        raise SystemExit(f"Missing env file: {env_path}")
    text = env_path.read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            _, value = line.split(":", 1)
            ip = value.strip()
            if ip:
                return ip
        m = re.search(r"\d{1,3}(?:\.\d{1,3}){3}", line)
        if m:
            return m.group(0)
    raise SystemExit(f"Could not parse robot IP from {env_path}")


def normalize_base(robot: str) -> str:
    r = robot.strip()
    if r.startswith("http://") or r.startswith("https://"):
        return r.rstrip("/")
    if ":" in r.split("/")[0] and r.count(":") == 1:
        return f"http://{r}"
    return f"http://{r}:31950"


def capture_preview(base: str, *, timeout: float = 30.0) -> tuple[bytes, str]:
    url = f"{base}/camera/capturePreviewImage"
    payload = json.dumps({"data": {}}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, image/jpeg, image/png, */*",
            "Opentrons-Version": OPENTRONS_VERSION,
        },
        method="POST",
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        content_type = resp.headers.get("Content-Type", "image/jpeg")
        return resp.read(), content_type


def extension_for_content_type(content_type: str) -> str:
    ct = content_type.lower()
    if "png" in ct:
        return "png"
    if "webp" in ct:
        return "webp"
    return "jpg"


def write_manifest(path: Path, robot: str, entries: list[dict]) -> None:
    path.write_text(
        json.dumps(
            {
                "robot": robot,
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "files": entries,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def countdown(seconds: int, *, next_index: int, total: int) -> None:
    print(f"\n[{next_index}/{total}] Adjust deck layout — next capture in {seconds}s")
    for remaining in range(seconds, 0, -1):
        print(f"  {remaining:2d}s remaining...", end="\r", flush=True)
        time.sleep(1)
    print(" " * 32, end="\r", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--env",
        type=Path,
        default=DEFAULT_ENV,
        help=f"Env file with robot IP (default: {DEFAULT_ENV})",
    )
    p.add_argument(
        "--robot",
        help="Override robot IP/host (default: read from --env)",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--count",
        type=int,
        default=25,
        help="Number of photos to capture (default: 25, typical range 20–30)",
    )
    p.add_argument(
        "--interval",
        type=int,
        default=10,
        help="Seconds between captures (default: 10)",
    )
    p.add_argument(
        "--prefix",
        default="deck",
        help="Filename prefix (default: deck)",
    )
    args = p.parse_args()

    if args.count < 1:
        raise SystemExit("--count must be >= 1")
    if args.interval < 1:
        raise SystemExit("--interval must be >= 1")

    robot_ip = args.robot or load_robot_ip(args.env)
    base = normalize_base(robot_ip)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = out_dir / "manifest.json"
    entries: list[dict] = []

    print(f"Robot:   {base}")
    print(f"Output:  {out_dir.resolve()}")
    print(f"Plan:    {args.count} photos, {args.interval}s apart")
    print("Press Ctrl+C to stop early.\n")

    session_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    try:
        for i in range(1, args.count + 1):
            if i > 1:
                countdown(args.interval, next_index=i, total=args.count)

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"{args.prefix}_{session_stamp}_{i:03d}_{ts}.jpg"
            dest = out_dir / filename

            print(f"[{i}/{args.count}] Capturing -> {dest.name} ...", end=" ", flush=True)
            try:
                blob, content_type = capture_preview(base)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")[:300]
                print(f"HTTP {e.code}")
                raise SystemExit(f"Capture failed: HTTP {e.code} {body}") from e
            except urllib.error.URLError as e:
                raise SystemExit(f"Robot unreachable at {base}: {e}") from e

            ext = extension_for_content_type(content_type)
            if dest.suffix.lower() != f".{ext}":
                dest = dest.with_suffix(f".{ext}")
            dest.write_bytes(blob)

            entry = {
                "index": i,
                "saved_to": str(dest.resolve()),
                "bytes": len(blob),
                "content_type": content_type,
                "captured_at": datetime.now(timezone.utc).isoformat(),
            }
            entries.append(entry)
            write_manifest(manifest_path, base, entries)
            print(f"OK ({len(blob)} bytes)")

    except KeyboardInterrupt:
        print("\nStopped by user.")

    print(f"\nDone: {len(entries)} photo(s) in {out_dir.resolve()}")
    print(f"Manifest: {manifest_path.resolve()}")


if __name__ == "__main__":
    main()
