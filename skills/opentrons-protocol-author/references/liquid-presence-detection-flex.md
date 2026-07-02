# Flex: Liquid Presence Detection (capacitive LLD)

Opentrons Flex pipettes support **Liquid Presence Detection (LPD)** via capacitive sensing in the tip. This is Flex-only hardware; OT-2 does not expose the same API.

Official Python API (apiLevel **≥ 2.24**):

| API | Purpose |
|-----|---------|
| `load_instrument(..., liquid_presence_detection=True)` | Enable capacitive sensing on the pipette |
| `pipette.detect_liquid_presence(well)` | Returns `True`/`False` whether liquid is detected |
| `pipette.require_liquid_presence(well)` | Raises if no liquid is detected |
| `pipette.measure_liquid_height(well)` | Returns liquid column height in mm **above well bottom** (larger = more liquid) |

Source: [Opentrons Python API — Liquid Presence Detection](https://docs.opentrons.com/python-api/building-block-commands/liquids/).

## When to use

| Scenario | Recommended mode |
|----------|------------------|
| Guard before aspirating from a source well | `require_liquid_presence` |
| Diagnostic / recovery (is liquid there?) | `detect_presence` |
| Low-volume reservoir or variable fill height | `measure_liquid_height` then aspirate with computed offset |

## Protocol pattern

```python
pipette = protocol.load_instrument(
    "flex_1channel_1000",
    "left",
    tip_racks=[tip_rack],
    liquid_presence_detection=True,
)

pipette.pick_up_tip()
pipette.require_liquid_presence(source_well)  # guard
pipette.transfer_with_liquid_class(...)       # or building-block aspirate/dispense
pipette.drop_tip(trash)
```

### Measure height before aspirate

`transfer_with_liquid_class` does not accept a probed depth directly. For dynamic depth, use building-block commands after probing:

```python
def aspirate_with_probed_depth(pipette, well, volume, clearance_mm=1.0):
    height_mm = pipette.measure_liquid_height(well)
    aspirate_depth_mm = max(0.5, height_mm - clearance_mm)
    pipette.aspirate(volume, well.bottom(aspirate_depth_mm))
    return height_mm
```

Example call:

```python
height_mm = aspirate_with_probed_depth(pipette, source_well, volume=50, clearance_mm=1.0)
protocol.comment(f"probed_height_mm={height_mm}")
```

See `assets/flex_liquid_probe_example.py` — RTP `probe_mode=measure_aspirate` runs measure → aspirate → dispense-to-trash as a teaching demo.

**Depth rule of thumb:** `measure_liquid_height` is relative to the well bottom. Use `well.bottom(height_mm - clearance_mm)` to aspirate slightly below the meniscus, or prefer `well.meniscus(z=-clearance_mm)` after probing.

## Simulation vs live

- Local simulation exercises protocol structure but **does not** reproduce real capacitive physics.
- Always run `probe_wells` simulate-first, then live with operator opt-in (`OPENTRONS_ENABLE_PROBE_WELLS=1`).

## Tips and liquids

- Use **conductive tips** compatible with Flex capacitive sensing.
- Volatile, foamy, or highly viscous liquids may reduce reliability — document assumptions in `design-notes.json`.
- Empty wells or wrong tip type can cause false negatives.

## MCP integration (recovery / pre-run probe)

| Tool | Role |
|------|------|
| `probe_wells` | Generate + simulate (+ optional live) temporary probe protocol |
| `apply_liquid_probe_results` | Write `observed_presence` / `observed_height_mm` into session state |
| `live_liquid_recovery_gate` | Read-only go/no-go before resume or substitution |

Live probe workflow: see [probe-wells-live-validation.md](../../../docs/runbooks/probe-wells-live-validation.md).

## Runtime parameters

Expose opt-in LPD in protocols via RTP:

```python
parameters.add_bool(
    display_name="Use liquid probe",
    variable_name="use_liquid_probe",
    default=False,
)
```

Default **off** preserves backward compatibility; enable only when the deck has conductive tips and liquids suitable for capacitive detection.
