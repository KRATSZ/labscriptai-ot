import test from "node:test";
import assert from "node:assert/strict";

import { heightMmToVolumeUl, lookupLabwareGeometry } from "../lib/probe.js";

const PI = Math.PI;

function cylinderVolumeUl(radiusMm, heightMm) {
  return PI * radiusMm * radiusMm * heightMm;
}

test("explicit cylindrical geometry matches hand calculation within 1 uL", () => {
  const radiusMm = 5;
  const heightMm = 10;
  const expected = cylinderVolumeUl(radiusMm, heightMm);

  const result = heightMmToVolumeUl({
    height_mm: heightMm,
    geometry: {
      well_depth_mm: 20,
      shape: "cylinder",
      radius_mm: radiusMm,
    },
  });

  assert.equal(result.method, "geometry:explicit");
  assert.equal(result.confidence, "observed");
  assert.ok(Math.abs(result.volume_ul - expected) <= 1, `expected ~${expected}, got ${result.volume_ul}`);
});

test("conical bottom approximation yields reasonable magnitude", () => {
  const result = heightMmToVolumeUl({
    height_mm: 5,
    labware_load_name: "nest_96_wellplate_200ul_flat",
    well_name: "A1",
  });

  assert.match(result.method, /^geometry:approximate:nest_96_wellplate_200ul_flat$/);
  assert.equal(result.confidence, "observed");
  assert.ok(result.volume_ul > 100 && result.volume_ul < 250, `unexpected volume ${result.volume_ul}`);
});

test("unknown labware without geometry returns null", () => {
  const result = heightMmToVolumeUl({
    height_mm: 8,
    labware_load_name: "totally_unknown_labware_xyz",
    well_name: "B2",
  });

  assert.equal(result.volume_ul, null);
  assert.equal(result.method, "unknown");
  assert.equal(result.confidence, null);
});

test("height_mm zero returns volume_ul zero", () => {
  const result = heightMmToVolumeUl({
    height_mm: 0,
    labware_load_name: "corning_96_wellplate_360ul_flat",
    well_name: "A1",
  });

  assert.equal(result.volume_ul, 0);
  assert.equal(result.confidence, "observed");
});

test("height exceeding well depth is clamped with notes", () => {
  const geometry = lookupLabwareGeometry("corning_96_wellplate_360ul_flat");
  const fullHeight = geometry.well_depth_mm + 5;

  const result = heightMmToVolumeUl({
    height_mm: fullHeight,
    labware_load_name: "corning_96_wellplate_360ul_flat",
    well_name: "A1",
  });

  const atCapacity = heightMmToVolumeUl({
    height_mm: geometry.well_depth_mm,
    labware_load_name: "corning_96_wellplate_360ul_flat",
    well_name: "A1",
  });

  assert.equal(result.volume_ul, atCapacity.volume_ul);
  assert.match(result.notes, /height_exceeds_well_depth_clamped/);
});

test("lookupLabwareGeometry hits and misses", () => {
  const hit = lookupLabwareGeometry("nest_96_wellplate_2ml_deep");
  assert.ok(hit);
  assert.equal(hit.well_depth_mm, 38);
  assert.equal(hit.approximate, true);

  const miss = lookupLabwareGeometry("nonexistent_labware");
  assert.equal(miss, null);
});

test("deep well segmented geometry is in expected volume range", () => {
  const result = heightMmToVolumeUl({
    height_mm: 20,
    labware_load_name: "nest_96_wellplate_2ml_deep",
    well_name: "C3",
  });

  assert.ok(result.volume_ul > 1000 && result.volume_ul < 1600, `unexpected deep-well volume ${result.volume_ul}`);
});
