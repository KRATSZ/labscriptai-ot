/** Private host-allocated stages preserve Windows sandbox capability ACLs. */
import fs from "node:fs";
import path from "node:path";

/** The confined host must supply an already-private, capability-granted root. */
export function inheritsPrivateAcl() {
  return process.platform === "win32" && process.env.LABSCRIPTAI_INHERIT_PRIVATE_ACL === "1";
}

/** Allocate a private child in the artifact owner's existing output directory. */
export function createArtifactStage(parent, prefix) {
  fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  return fs.mkdtempSync(path.join(parent, prefix));
}

/** Remove only unused, empty stages after the helper's exit is established. */
export function cleanUnusedStages(stages) {
  for (const stage of stages) {
    try { fs.rmdirSync(stage); }
    catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      // Published, partial or already-consumed stages belong to the invocation owner.
    }
  }
}
