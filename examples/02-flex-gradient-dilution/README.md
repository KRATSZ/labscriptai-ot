# Example 02 — Flex gradient dilution (2-fold, row A)

End-to-end walkthrough: intent → protocol → local simulation. No live robot required.

## What this demonstrates

- Gradient dilution as serial 2-fold dilution along row A
- Intent review with explicit plate mapping and tip policy
- Flex deck layout (trash, tip rack, reservoir, plate)
- Local simulation gate

## Concentration gradient

| Well | Relative concentration (2-fold steps) |
|------|---------------------------------------|
| A1   | 100% (stock — operator-loaded)        |
| A2   | 50%                                   |
| A3   | 25%                                   |
| A4   | 12.5%                                 |
| …    | …                                     |
| A8   | ~0.78% (7 steps default)              |

## Operator prep

1. Load stock/sample into **A1** before starting the run.
2. Fill reservoir well **A1** with diluent/buffer (≥2 mL recommended).
3. Place labware per deck layout in `design-notes.json`.

## Files

| File | Purpose |
|------|---------|
| `protocol.py` | Gradient dilution protocol |
| `design-notes.json` | Locked intent and design decisions |
| `README.md` | This guide |
