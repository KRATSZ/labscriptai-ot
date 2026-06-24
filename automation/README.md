# Lab hardware helpers

Operational artifacts from live Flex work — not part of the plugin core.

| Path | Purpose |
|------|---------|
| `labware/` | Third-party PE tip rack definitions (`custom_beta`) and generator |
| `verify_pe_tip_pickup.py` | Dry-run protocol to validate custom tip rack pickup |
| `verify_c1_offset.py` | Dry-run protocol to validate temperature-module offset on C1 |
| `click_deck_corners.py` | Phase 0: calibrate deck homography corners |
| `label_deck_bboxes.py` | Phase 3: bbox labels for YOLO training |
| `train_deck_yolo.py` | Train/export deck labware detector |
| `capture_photo_series.py` | Timed robot camera capture for datasets |
| `run_test_vision.py` | Batch vision_check on test photos |
| `photo/deck_calibration.json` | Machine camera homography (reuse across photos) |
| `deck_layout_policy.json` | Fixed modules/trash + movable labware detection scope |
| `../vision/models/weights/deck_v2_best.pt` | Trained deck detector checkpoint |

See [docs/custom-labware-guide.md](../docs/custom-labware-guide.md). Deck vision setup: [docs/GETTING_STARTED.md#deck-vision-setup](../docs/GETTING_STARTED.md#deck-vision-setup). Offset helper: `node scripts/verify-c1-offset-run.mjs`.
