# Deck vision (lab-trained YOLO)

Lab-trained deck vision helps agents **observe** Flex deck layout from camera photos. It maps detections to Flex slots and reports occupancy + labware type for **movable** items only.

**Safety:** Vision is **observation-only**. It does **not** replace committed deck truth. Always compare with `reconcile_state` and robot APIs before acting on layout. See [policy/workflows.md](../policy/workflows.md) (*Optional deck vision*) and [GLOSSARY.md](GLOSSARY.md).

The pipeline is included in this plugin checkout. No separate feature branch is needed.

## Automatic workflow

`run_protocol` attempts configured Flex vision after software preflight and immediately before sending `play`. It derives the **starting** slot layout from the successful local simulation's load commands, captures a fresh preview image, runs YOLO, and requests an Ark/Kimi second opinion only on uncertainty or mismatch.

- `OPENTRONS_PREFLIGHT_VISION=auto` (default): attempt the configured check. `off` disables it.
- Per run, `preflight_vision=on|off` explicitly requests/skips it and takes priority over the environment default. `skip_preflight=true` skips vision along with the software preflight; `skip_preflight_deck_diff=true` only skips the API deck diff.
- Missing camera/calibration/dependencies, unsupported labware or unresolved runtime-parameter layouts are reported as `not_checked`, never passed. These optional omissions do not prevent an ordinary run.
- Observed mismatch or unresolved visual uncertainty stops before play and returns reconcile/re-check guidance. The tool does not move labware or change session deck truth.
- `auto_play=false` defers checking: the uploaded run's expectations are persisted, and `control_run(action=play)` checks a fresh photo at actual startup, including after a server restart. Runs stopped by a visual mismatch retain this requirement when retried. After a manual layout change, use `control_run(deck_changed=true, expected_layout={...})` when playing/resuming; pass the **current** expected layout, not the original protocol layout after moves. Each call captures again. Stop/pause and normal running do not trigger photography.

Every attempt returns `vision_gate` with status, `report_path`, and available image/annotated-image paths. JSON reports live under `PLUGIN_DATA/artifacts/deck-vision/check-*/vision-report.json`; old reports are audit evidence, not reusable readiness checks.

For a separate staged review use `deck_vision_check(mode=preflight, file_path=...)`, `analysis_path=...`, or an explicit `expected_layout` such as `{"B2":"plate","B3":"empty"}`. Explicit layouts check only the supplied supported slots. Local saved-image observation remains available with `mode=local`. The detector groups tiprack sizes as `tiprack` for comparison and does not establish exact consumable identity, tip counts, or liquid contents.

Without a layout baseline, a preflight call can still capture diagnostic evidence for recovery, but returns `not_checked` for layout agreement. Late loads whose starting placement is ambiguous are excluded from comparison rather than assumed empty. Old reports and the fixed-slot policy do not establish physical module placement.

---

## What it detects (Silabrobot001)

Configured in `automation/deck_layout_policy.json` for robot `192.168.66.102`.

### Fixed slots (not vision targets)

| Slot | Hardware |
|------|----------|
| A1 | PCR thermocycler |
| B1 | PCR thermocycler (same module as A1) |
| C1 | Temperature module |
| D1 | Heater-shaker |
| A3 | Trash bin |

`deck_vision_check(mode=local)` marks these as `state: fixed` with `source: layout_policy`.

### Detection slots (7 movable labware positions)

`A2`, `B2`, `B3`, `C2`, `C3`, `D2`, `D3`

### Detection classes (5)

`tiprack_50`, `tiprack_200`, `tiprack_1000`, `reservoir`, `plate`

---

## Architecture

```
Offline (once / when retraining)
  click_deck_corners.py  →  deck_calibration.json
  deck_layout_policy.json
  label_deck_bboxes.py   →  bbox sidecars
  export_yolo_dataset.py →  vision/data/deck_phase3/
  train_deck_yolo.py     →  vision/models/weights/deck_v2_best.pt

Runtime (each check)
  run_protocol: simulation → software preflight
    → fresh capture → YOLO vs analyzed starting layout → optional VLM
    → report → play only if no unresolved visual mismatch/uncertainty

  mismatch: reconcile_state + API review → resolve → fresh check
```

MCP tool reference: [MCP_TOOLS.md](MCP_TOOLS.md) → `deck_vision_check(mode=local)` [L4].

---

## One-time setup

### 1. Python dependencies

In the same environment as `OPENTRONS_PYTHON`:

```powershell
.venv\Scripts\pip install ultralytics opencv-python-headless pillow
```

Verify:

```powershell
node scripts\verify-setup.mjs
```

Expect passes for: deck layout policy, deck calibration, deck YOLO weights, vision Python deps.

### 2. Calibrate camera homography (once per camera angle)

```powershell
.venv\Scripts\python.exe automation\click_deck_corners.py --image "C:\path\to\current-deck.jpg"
```

First capture a current deck image with `capture_image(mode=preview)`, then use its saved path above. Click corners in order **A1 → A3 → D3 → D1** (deck view). Writes:

`automation/photo/deck_calibration.json`

`deck_vision_check(mode=local)` loads `optional_deck_corners_norm` from this file automatically. Re-calibrate if the camera mount or angle changes. `--show` previews an existing calibration without editing; it cannot create one. Automatic preflight requires calibration and rejects a calibration bound to a different robot; uncalibrated local observations are not a preflight pass.

### 3. Machine layout policy

Edit `automation/deck_layout_policy.json` when fixed modules or detection scope change.

Optional override:

```powershell
$env:OPENTRONS_DECK_LAYOUT_POLICY = "$PWD\automation\deck_layout_policy.json"
```

### 4. Trained weights

Bundled checkpoint (after training on this machine):

`vision/models/weights/deck_v2_best.pt`

Optional override:

```powershell
$env:OPENTRONS_DECK_YOLO_WEIGHTS = "$PWD\vision\models\weights\deck_v2_best.pt"
```

Optional calibration path override:

```powershell
$env:OPENTRONS_DECK_CALIBRATION = "$PWD\automation\photo\deck_calibration.json"
```

### 5. Cursor MCP

Ensure `.cursor/mcp.json` sets:

- `OPENTRONS_PLUGIN_ROOT` → repo root
- `OPENTRONS_PYTHON` → `.venv\Scripts\python.exe`

Reload MCP after updating server code or changing `mcp.json` env vars. **Not required** after editing `vision_check.py`, policy, calibration, or weights — each local vision call spawns a fresh Python process.

---

## Daily use

### Option A — Cursor Agent (recommended)

Configured vision is attempted automatically before `run_protocol` starts movement. The following prompts also work for independent checks:

**Quick deck check**

> 连接 192.168.66.102，拍一张 deck 照片，跑 deck_vision_check(mode=local)，列出 7 个检测槽位的占用和类型，并与 reconcile_state 对比。固定槽位 A1/B1/C1/D1/A3 仅作 layout_policy 参考。

**Before a run**

> 实验开始前，使用 deck_vision_check(mode=preflight, file_path=协议路径) 检查台面，列出差异和标注图，不启动实验。

**After rearranging labware**

> 我刚换了台面布局，请拍照做 vision 检查，标注图路径也告诉我。

Agent tool sequence:

```
camera_settings(action=status) → capture_image(mode=preview) → deck_vision_check(mode=local) → reconcile_state
```

Read `slot_observations` for detection slots; ignore or treat `fixed` slots as machine config, not vision inference.

### Option B — Command line

**Timed capture from robot** (e.g. 5 photos, 10 s apart):

```powershell
.venv\Scripts\python.exe automation\capture_photo_series.py `
  --count 5 --interval 10 `
  --robot 192.168.66.102 `
  --out automation\photo\test `
  --prefix test
```

Robot IP can also be read from `automation/.env`.

**Batch vision on saved photos:**

```powershell
.venv\Scripts\python.exe automation\run_test_vision.py
```

Defaults: `automation/photo/test/test_*.jpg` → JSON + annotated images under `automation/photo/test/vision/`.

**Single-image deck_vision_check(mode=local)** (stdin JSON to script):

```powershell
$payload = @{
  mode = "deck"
  image_path = "C:\...\automation\photo\test\test_....jpg"
  conf_threshold = 0.2
} | ConvertTo-Json -Compress
$payload | .venv\Scripts\python.exe servers\opentrons-mcp\scripts\vision_check.py
```

Calibration and policy are loaded from repo paths; no need to pass `deck_corners_norm` manually.

---

## Output guide

### `slot_observations` (per slot)

| `state` | Meaning |
|---------|---------|
| `fixed` | Fixed hardware from layout policy — not detected |
| `empty` | Detection slot, no labware |
| `occupied` | Detection slot, labware present (`label` set) |
| `uncertain` | Low confidence or mapping ambiguity — needs human review |

### Summary string (example)

`7/7 detection slots confident; 0 detection slots need review; 5 fixed slots from layout policy.`

### Artifacts

| Output | Location |
|--------|----------|
| Annotated deck image | MCP `annotated_image_path` or `.../vision/annotated/*-vision-deck.jpg` |
| Full JSON | `.../vision/*.vision.json`, `vision_report.json` |

---

## Maintenance (occasional)

| When | Action |
|------|--------|
| Camera angle changed | Re-run `click_deck_corners.py --image <current-photo>` |
| Fixed modules moved | Update `deck_layout_policy.json` |
| New labware type or poor accuracy | Capture photos → `label_deck_bboxes.py` → `export_yolo_dataset.py` → `train_deck_yolo.py` |
| New plate/reservoir layouts | Add bbox labels in detection slots, retrain |
| Refresh phase-3 manifest | `setup_phase3_labels.py --refresh-manifest` |

### Bbox labeling

```powershell
# All phase-3 manifest images
.venv\Scripts\python.exe automation\label_deck_bboxes.py --phase3

# Specific folder (e.g. new plate photos)
.venv\Scripts\python.exe automation\label_deck_bboxes.py --image automation\photo\plate\*.jpg
```

Keys **1–5**: `tiprack_50`, `tiprack_200`, `tiprack_1000`, `reservoir`, `plate`.  
**s** save, **n/p** next/prev, **q** quit. Do not draw boxes in fixed (red) slots.

### Retrain

```powershell
.venv\Scripts\python.exe automation\export_yolo_dataset.py
.venv\Scripts\python.exe automation\train_deck_yolo.py --epochs 80 --batch 4
```

Updates `vision/models/weights/deck_v2_best.pt`.

---

## Key files

| Path | Role |
|------|------|
| `automation/deck_layout_policy.json` | Fixed slots + detection scope |
| `automation/photo/deck_calibration.json` | Homography corners |
| `vision/models/weights/deck_v2_best.pt` | Trained detector |
| `servers/opentrons-mcp/scripts/vision_check.py` | MCP deck vision backend |
| `servers/opentrons-mcp/lib/deck-vision-layout.js` | Initial analyzed layout, calibration availability, run decision |
| `automation/capture_photo_series.py` | Robot timed capture |
| `automation/run_test_vision.py` | Offline batch evaluation |
| `automation/click_deck_corners.py` | Calibration GUI |
| `automation/label_deck_bboxes.py` | Training labels GUI |
| `automation/train_deck_yolo.py` | Training script |
| `automation/photo/bbox_labels/` | Bbox sidecars |
| `vision/data/deck_phase3/` | YOLO export dataset |

Tooling index: [automation/README.md](../automation/README.md).

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `verify-setup` warns on vision deps | `pip install ultralytics opencv-python-headless pillow` |
| All slots `uncertain` / wrong slot mapping | Re-calibrate `deck_calibration.json` |
| Fixed slot shows wrong labware | Expected — fixed slots ignore vision; check detection slots only |
| `plate` never detected | Add plate bbox labels and retrain |
| MCP vision fails | Check `OPENTRONS_PYTHON`, run `node scripts/verify-setup.mjs` |
| Capture fails | `camera_settings(action=status)`; confirm robot IP and Flex camera API |
| Stale behavior after env change | Reload MCP in Cursor settings |

MCP startup issues: [runbooks/mcp-wont-start.md](runbooks/mcp-wont-start.md).

---

## Related docs

- [GETTING_STARTED.md](GETTING_STARTED.md) — install and MCP enablement
- [policy/workflows.md](../policy/workflows.md) — canonical vision tool sequence
- [MCP_TOOLS.md](MCP_TOOLS.md) — `deck_vision_check(mode=local)`, `capture_image(mode=preview)`
- [GLOSSARY.md](GLOSSARY.md) — deck truth vs observation
