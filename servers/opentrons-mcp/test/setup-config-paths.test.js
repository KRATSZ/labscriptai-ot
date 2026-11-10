import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { extractTomlString, extractTomlArrayFirstString, sameAbsolutePath } from "../../../scripts/toml-values.mjs";

test("setup reads escaped Windows TOML paths as absolute filesystem paths", () => {
  const text = String.raw`
args = ["C:\\Users\\用户\\My Project\\servers\\opentrons-mcp\\index.js"]
OPENTRONS_PLUGIN_ROOT = "C:\\Users\\用户\\My Project"
`;
  const root = extractTomlString(text, "OPENTRONS_PLUGIN_ROOT");
  assert.equal(root, String.raw`C:\Users\用户\My Project`);
  assert.equal(sameAbsolutePath(root, "C:/Users/用户/My Project/", path.win32), true);
  assert.equal(sameAbsolutePath(extractTomlArrayFirstString(text, "args"),
    "c:/users/用户/My Project/servers/opentrons-mcp/index.js", path.win32), true);
});

test("setup also accepts literal paths, indented values and commented multiline arrays", () => {
  const text = String.raw`
  OPENTRONS_PLUGIN_ROOT = 'C:\Users\name\project' # preserve literal backslashes
args = [ # launch Node
  # entry point with spaces
  'C:\Users\name\project\index.js',
]
`;
  assert.equal(extractTomlString(text, "OPENTRONS_PLUGIN_ROOT"), String.raw`C:\Users\name\project`);
  assert.equal(extractTomlArrayFirstString(text, "args"), String.raw`C:\Users\name\project\index.js`);
  assert.equal(extractTomlString('OTHER_ROOT = "/wrong"', "ROOT"), null);
  assert.equal(extractTomlArrayFirstString("args = []", "args"), null);
});

test("setup decodes quoted characters and TOML Unicode without accepting invalid escapes", () => {
  assert.equal(extractTomlString(String.raw`root = "/tmp/\"quoted\"/\u7528\U00006237"`, "root"), '/tmp/"quoted"/用户');
  assert.equal(extractTomlString(String.raw`root = "C:\\Users\\User"`, "root"), String.raw`C:\Users\User`);
  for (const invalid of [String.raw`root = "C:\Users\name"`, String.raw`root = "\uD800"`, String.raw`root = "\U00110000"`]) {
    assert.throws(() => extractTomlString(invalid, "root"), /Invalid TOML string escape/);
  }
});

test("setup still rejects relative, missing and wrong-checkout paths", () => {
  const expected = "C:/Users/name/project";
  for (const actual of [null, "", "project", "C:project", "C:/Users/name/other-project"]) {
    assert.equal(sameAbsolutePath(actual, expected, path.win32), false, String(actual));
  }
  assert.equal(sameAbsolutePath("/home/name/project/./", "/home/name/project", path.posix), true);
  assert.equal(sameAbsolutePath("/home/name/Project", "/home/name/project", path.posix), false);
});
