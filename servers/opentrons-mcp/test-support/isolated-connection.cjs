// Tests issue mocked robot requests: never replace the operator's saved robot.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// POSIX tests use a shebang Python file as a fake interpreter. Windows cannot
// spawn that file directly; execute this named test fixture through Python.
// Keep this adaptation in tests, without enabling a shell in production tools.
if (process.platform === "win32") {
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  const python = process.env.OPENTRONS_PYTHON || path.resolve(__dirname, "../../../.venv/Scripts/python.exe");
  if (fs.existsSync(python)) {
    childProcess.spawn = (command, args = [], options) =>
      path.basename(command) === "fake-simulation-runner.py"
        ? spawn(python, [command, ...args], options)
        : spawn(command, args, options);
    require("node:module").syncBuiltinESMExports();
  }
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-test-connection-"));
process.env.OPENTRONS_CONNECTION_FILE = path.join(home, "robot-connection.json");
// Test files run in separate processes and often reuse mocked run IDs. Keep
// artifacts/pending checks separate as well as connections, outside user data.
process.env.PLUGIN_DATA = path.join(home, "data");
delete process.env.OPENTRONS_HOST;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
