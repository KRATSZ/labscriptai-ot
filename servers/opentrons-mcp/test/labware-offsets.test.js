import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeLabwareOffsets,
  prepareOffsetsForRunCreate,
  selectOffsetsForRun,
} from "../lib/labware-offsets.js";

test("dedupeLabwareOffsets keeps newest offset per definition and location", () => {
  const offsets = [
    {
      id: "old",
      createdAt: "2026-06-09T07:35:11.007117Z",
      definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
      locationSequence: [
        { kind: "onModule", moduleModel: "temperatureModuleV2" },
        { kind: "onAddressableArea", addressableAreaName: "temperatureModuleV2C1" },
      ],
      vector: { x: 0, y: 0, z: 8 },
    },
    {
      id: "new",
      createdAt: "2026-06-09T07:40:47.905554Z",
      definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
      locationSequence: [
        { kind: "onModule", moduleModel: "temperatureModuleV2" },
        { kind: "onAddressableArea", addressableAreaName: "temperatureModuleV2C1" },
      ],
      vector: { x: 0, y: 0, z: 5 },
    },
  ];

  const deduped = dedupeLabwareOffsets(offsets);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, "new");
});

test("selectOffsetsForRun drops anyLocation when a specific offset exists", () => {
  const offsets = [
    {
      id: "generic",
      createdAt: "2026-06-09T07:07:10.356123Z",
      definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
      locationSequence: "anyLocation",
      vector: { x: 0, y: 0, z: 0 },
    },
    {
      id: "specific",
      createdAt: "2026-06-09T07:40:47.905554Z",
      definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
      locationSequence: [
        { kind: "onModule", moduleModel: "temperatureModuleV2" },
        { kind: "onAddressableArea", addressableAreaName: "temperatureModuleV2C1" },
      ],
      vector: { x: 0, y: 0, z: 5 },
    },
  ];

  const selected = selectOffsetsForRun(offsets);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "specific");
});

test("prepareOffsetsForRunCreate strips stored fields and skips anyLocation", () => {
  const prepared = prepareOffsetsForRunCreate([
    {
      id: "generic",
      createdAt: "2026-06-09T07:07:10.356123Z",
      definitionUri: "opentrons/nest_12_reservoir_15ml/2",
      locationSequence: "anyLocation",
      vector: { x: 0, y: 0, z: 0 },
    },
    {
      id: "specific",
      createdAt: "2026-06-09T07:40:47.905554Z",
      definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
      locationSequence: [
        { kind: "onModule", moduleModel: "temperatureModuleV2" },
        { kind: "onAddressableArea", addressableAreaName: "temperatureModuleV2C1" },
      ],
      vector: { x: 0, y: 0, z: 5 },
    },
  ]);

  assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0], {
    definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
    locationSequence: [
      { kind: "onModule", moduleModel: "temperatureModuleV2" },
      { kind: "onAddressableArea", addressableAreaName: "temperatureModuleV2C1" },
    ],
    vector: { x: 0, y: 0, z: 5 },
  });
});
