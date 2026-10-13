#!/usr/bin/env python3
"""Run the vendored LogicPass package on one analyze JSON.

The checker is copied into automation/vendor so this plugin does not import
Opentrons-Lab-Agent from disk. Prints one JSON object.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[3] / "automation" / "vendor"
sys.path.insert(0, str(VENDOR))


def main() -> int:
    analysis = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    sim_pass = True if len(sys.argv) < 3 else sys.argv[2] != "false"
    from labscriptai.benchmark.logicpass import evaluate_logicpass, load_analyze_json

    adapter = load_analyze_json(analysis if analysis and analysis.is_file() else None)
    result = evaluate_logicpass(sim_pass=sim_pass, adapter=adapter)
    payload = result.to_dict()
    print(json.dumps({
        "outcome": payload["outcome"],
        "logic_pass": payload["logic_pass"],
        "sim_pass": payload["sim_pass"],
        "final_pass_v2": payload["final_pass_v2"],
        "unevaluable": bool(adapter.unevaluable),
        "issues": [
            {
                "code": issue["code"],
                "step_index": issue["step_index"],
                "command_id": issue["command_id"],
                "well": issue["well"],
                "detail_text": issue["detail_text"],
                "severity": issue["severity"],
            }
            for issue in payload["issues"]
        ],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
