/**
 * OpenCode plugin — consume LabscriptAI OT outbox on session.idle.
 *
 * Install: add this file to `opencode.jsonc` → `plugin` array.
 * Requires OPENTRONS_PLUGIN_ROOT and OPENTRONS_SESSION_ID in the environment.
 *
 * Experimental — verify against your OpenCode / @opencode-ai/plugin version.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type SessionPromptClient = {
  session?: {
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<{ type: "text"; text: string }> };
    }) => Promise<unknown>;
  };
};

type IdleInput = {
  sessionID?: string;
  client?: SessionPromptClient;
};

export const LabscriptaiOutboxWake = async () => ({
  "session.idle": async (input: IdleInput) => {
    const root = process.env.OPENTRONS_PLUGIN_ROOT;
    const sessionID = input.sessionID;
    if (!root || !sessionID) {
      return;
    }
    const session = process.env.OPENTRONS_SESSION_ID || "default";
    try {
      const { stdout } = await execFileAsync(
        "node",
        [
          `${root}/scripts/consume-runtime-outbox.mjs`,
          "--host",
          "opencode",
          "--session-id",
          session,
          "--format",
          "opencode-prompt",
          "--ack",
        ],
        { env: process.env },
      );
      const payload = JSON.parse(stdout.trim());
      if (payload.action !== "wake" || !payload.prompt) {
        return;
      }
      await input.client?.session?.prompt?.({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: payload.prompt }] },
      });
    } catch (error: unknown) {
      const code = (error as { code?: number | string })?.code;
      if (code === 2) {
        return;
      }
    }
  },
});

export default LabscriptaiOutboxWake;
