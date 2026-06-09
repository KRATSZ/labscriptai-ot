import fs from "fs";
import { requestRobotJson } from "../servers/opentrons-mcp/lib/http.js";

const ROBOT = process.env.OPENTRONS_HOST?.replace(/^https?:\/\//, "").split(":")[0] || "192.168.66.106";
const PROTO = new URL("../automation/verify_c1_offset.py", import.meta.url);

async function deleteOffset(id, label) {
  try {
    const r = await requestRobotJson("DELETE", ROBOT, `/labwareOffsets/${id}`);
    console.log(`Deleted ${label} (${id}) z=${r.data?.vector?.z}`);
    return true;
  } catch (error) {
    console.log(`Skip delete ${label} (${id}): ${String(error.message).slice(0, 120)}`);
    return false;
  }
}

async function uploadProtocol(filePath) {
  const fileBuf = fs.readFileSync(filePath);
  const boundary = `----LabscriptAIVerify${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="verify_c1_offset.py"\r\n` +
      `Content-Type: text/x-python\r\n\r\n`,
    "utf8",
  );
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="protocolKind"\r\n\r\n` +
      `standard\r\n` +
      `--${boundary}--\r\n`,
    "utf8",
  );
  const body = Buffer.concat([prefix, fileBuf, suffix]);
  const url = `http://${ROBOT}:31950/protocols`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Opentrons-Version": "4",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Upload failed: ${JSON.stringify(json)}`);
  }
  return json.data?.id;
}

async function pollUntilAspirate(runId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const run = await requestRobotJson("GET", ROBOT, `/runs/${runId}`);
    const status = run.data?.status;
    const cmds = await requestRobotJson("GET", ROBOT, `/runs/${runId}/commands`, {
      searchParams: { pageLength: 50 },
    });
    const list = cmds.data || [];
    const aspirate = list.find(command => command.commandType === "aspirate");
    if (aspirate?.status === "succeeded") {
      return { run: run.data, commands: list, status };
    }
    if (["failed", "stopped", "succeeded"].includes(status)) {
      return { run: run.data, commands: list, status };
    }
  }
  throw new Error("Timed out waiting for aspirate");
}

const toDelete = [
  ["347190ce-2c14-4f20-935f-328d73436920", "200ul_flat C1 +8mm duplicate"],
  ["3c706e4e-d1fb-43c7-a2ca-4724563e6036", "200ul_flat anyLocation z=0"],
];

console.log("=== Step 1: clean duplicate offsets ===");
for (const [id, label] of toDelete) {
  await deleteOffset(id, label);
}

const offsetsRes = await requestRobotJson("GET", ROBOT, "/labwareOffsets");
const flatOffsets = (offsetsRes.data || []).filter(entry =>
  (entry.definitionUri || "").includes("200ul_flat"),
);
console.log("\nRemaining 200ul_flat offsets:");
console.log(JSON.stringify(flatOffsets, null, 2));

const c1Offset = flatOffsets.find(entry =>
  Array.isArray(entry.locationSequence) &&
  entry.locationSequence.some(item => item.addressableAreaName === "temperatureModuleV2C1"),
);
if (!c1Offset) {
  throw new Error("No C1-specific 200ul_flat offset found after cleanup");
}

console.log("\n=== Step 2: upload verify protocol ===");
const protocolId = await uploadProtocol(PROTO);
console.log("Protocol id:", protocolId);

console.log("\n=== Step 3: create run with labwareOffsets attached ===");
const runCreate = await requestRobotJson("POST", ROBOT, "/runs", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    data: {
      protocolId,
      labwareOffsets: [c1Offset],
    },
  }),
});
const runId = runCreate.data?.id;
console.log("Run id:", runId);
console.log("Run labwareOffsets count:", runCreate.data?.labwareOffsets?.length ?? 0);

console.log("\n=== Step 4: play run ===");
await requestRobotJson("POST", ROBOT, `/runs/${runId}/actions`, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: { actionType: "play" } }),
});

const { run, commands, status } = await pollUntilAspirate(runId);
const loadSource = commands.find(
  command =>
    command.commandType === "loadLabware" &&
    command.params?.loadName === "nest_96_wellplate_200ul_flat",
);
const aspirate = commands.find(command => command.commandType === "aspirate");

console.log("\n=== VERIFY SUMMARY ===");
console.log(`C1 offset kept: z=${c1Offset.vector.z} mm (id ${c1Offset.id})`);
console.log(`Run labwareOffsets in state: ${run?.labwareOffsets?.length ?? 0}`);
console.log(`loadLabware offsetId: ${loadSource?.result?.offsetId ?? "(none)"}`);
console.log(`aspirate z param (relative): ${aspirate?.params?.wellLocation?.offset?.z ?? "(n/a)"}`);
console.log(`aspirate status: ${aspirate?.status ?? "(n/a)"}`);
console.log(`run status: ${status}`);
console.log("Baseline without offset attach: absolute z ~14.26, deck Z_L ~102.96");
console.log("Expected with +5 mm offset attach: absolute z ~19.26, deck Z_L ~107.96");
console.log(`Run link: http://${ROBOT}:31950/runs/${runId}`);
