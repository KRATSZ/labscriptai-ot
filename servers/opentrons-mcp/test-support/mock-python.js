import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Mock the Python subprocess boundary rather than executing a POSIX shell file.
// The real Node executable satisfies the runtime's path-existence check on all OSes.
export function mockPython(t, { executable = process.execPath, version = "3.12.0", opentrons = "9.9.9" } = {}) {
  const realExecFileSync = childProcess.execFileSync;
  const mocked = t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    if (file !== executable) return realExecFileSync(file, args, options);
    if (args.length === 2 && args[0] === "-c") {
      if (args[1] === "import sys; print(sys.version.split()[0])") return `${version}\n`;
      if (args[1] === "import opentrons; print(opentrons.__version__)") return `${opentrons}\n`;
    }
    throw new Error(`Unexpected Python invocation: ${JSON.stringify(args)}`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return executable;
}
