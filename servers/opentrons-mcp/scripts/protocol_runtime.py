"""Choose the dedicated OT-2 analyzer without changing Flex's Python environment."""
import ast
import hashlib
import json
import os
from pathlib import Path
import sys
import platform
import subprocess


class RuntimeSelectionError(RuntimeError):
    pass


def verify_ot2_python(python):
    try:
        done = subprocess.run([str(python), "-c", 'import importlib.metadata; print(importlib.metadata.version("opentrons"))'],
                              capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeSelectionError(f"OT-2 analyzer unavailable: {exc}. Run node scripts/install-runtime.mjs or check OPENTRONS_OT2_PYTHON.") from exc
    if done.returncode or done.stdout.strip() != "8.8.2":
        raise RuntimeSelectionError(f"OT-2 requires its accepted Opentrons 8.8.2 analyzer; found {done.stdout.strip() or 'unavailable'}. Run node scripts/install-runtime.mjs or check OPENTRONS_OT2_PYTHON. Flex's environment is unchanged.")
    return str(python)


def protocol_robot(protocol):
    """Inspect literal requirements only; never execute user code to route it."""
    try:
        tree = ast.parse(Path(protocol).read_text(encoding="utf-8-sig"))
    except (OSError, SyntaxError, UnicodeError):
        return None
    requirements = {}
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if any(isinstance(target, ast.Name) and target.id == "requirements" for target in targets):
            try:
                requirements = ast.literal_eval(node.value)
            except (ValueError, TypeError, SyntaxError):
                return None
        elif not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # Leave dynamic declarations to the configured analyzer. In
            # particular, never send a mutated Flex declaration to OT-2.
            if any(isinstance(child, ast.Name) and child.id == "requirements" for child in ast.walk(node)):
                return None
    if not isinstance(requirements, dict):
        return None
    kind = requirements.get("robotType", "OT-2")
    return kind if kind in ("OT-2", "Flex") else None


def select_python(explicit_python, protocol):
    base = explicit_python or sys.executable
    if protocol_robot(protocol) != "OT-2":
        return base
    override = os.environ.get("OPENTRONS_OT2_PYTHON")
    if override:
        return verify_ot2_python(override)
    root = Path(__file__).resolve().parents[3]
    local = root / ".venv-ot2" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if local.is_file():
        return verify_ot2_python(local)
    # Installers store shared runtimes outside the plugin directory.
    home = os.environ.get("LABSCRIPTAI_HOME")
    if not home:
        if sys.platform == "darwin":
            home = Path.home() / "Library/Application Support/labscriptai-ot"
        elif os.name == "nt":
            home = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "labscriptai-ot"
        else:
            home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "labscriptai-ot"
    try:
        digest = hashlib.sha256((root / "requirements-ot2.lock").read_bytes()).hexdigest()[:20]
        arch = {"aarch64": "arm64", "amd64": "x64", "x86_64": "x64", "x86": "ia32"}.get(platform.machine().lower(), platform.machine().lower())
        key = f"python-ot2-{sys.platform}-{arch}-{digest}"
        python = Path(home) / "runtimes" / key / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        marker = json.loads((python.parent.parent / ".labscriptai-ready.json").read_text())
        if python.is_file() and marker.get("schema") == 1 and marker.get("ready") and marker.get("kind") == "python-ot2" and marker.get("key") == key:
            return verify_ot2_python(python)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return verify_ot2_python(base)
