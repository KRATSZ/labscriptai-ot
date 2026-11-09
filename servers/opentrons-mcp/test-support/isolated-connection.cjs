// Tests issue mocked robot requests: never replace the operator's saved robot.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-test-connection-"));
process.env.OPENTRONS_CONNECTION_FILE = path.join(home, "robot-connection.json");
delete process.env.OPENTRONS_HOST;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
