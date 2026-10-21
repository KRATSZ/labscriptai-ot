import fs from "node:fs";
import path from "node:path";

export function buildIdentity(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "servers/opentrons-mcp/package.json"), "utf8")).version;
  const file = path.join(root, "build-info.json");
  if (!fs.existsSync(file)) return { version, build_id: "development", packaged: false, consistent: true };
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...info, packaged: true, consistent: info.version === version };
}
