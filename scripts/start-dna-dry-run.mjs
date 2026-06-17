import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { requestRobotJson } from "../servers/opentrons-mcp/lib/http.js";
import {
  buildProtocolRunCreateBody,
  resolveRunLabwareOffsets,
} from "../servers/opentrons-mcp/lib/labware-offsets.js";

const ROBOT = process.env.ROBOT_IP || "192.168.66.106";
const PROTO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../automation/protocol_dna_operations.py",
);

async function uploadProtocol(filePath) {
  const fileBuf = fs.readFileSync(filePath);
  const boundary = `----DNADryRun${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="protocol_dna_operations.py"\r\n` +
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
  const response = await fetch(`http://${ROBOT}:31950/protocols`, {
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

const protocolId = await uploadProtocol(PROTO);
console.log("Uploaded protocol:", protocolId);

const labwareOffsets = await resolveRunLabwareOffsets(ROBOT);
console.log("Location-specific offsets to attach:", labwareOffsets?.length ?? 0);

const runCreate = await requestRobotJson("POST", ROBOT, "/runs", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(
    buildProtocolRunCreateBody({
      protocolId,
      runTimeParameters: {
        dry_run: true,
        recovery_seconds: 60,
        use_fragment_3: false,
      },
      labwareOffsets,
    }),
  ),
});
const runId = runCreate.data?.id;
if (!runId) {
  throw new Error(`Run creation failed: ${JSON.stringify(runCreate)}`);
}

console.log("Created run:", runId);
console.log("Run labwareOffsets count:", runCreate.data?.labwareOffsets?.length ?? 0);

await requestRobotJson("POST", ROBOT, `/runs/${runId}/actions`, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: { actionType: "play" } }),
});

console.log("Play started.");
console.log(`Monitor: http://${ROBOT}:31950/runs/${runId}`);
