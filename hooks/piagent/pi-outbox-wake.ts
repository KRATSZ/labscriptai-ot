/**
 * Pi Coding Agent extension — consume LabscriptAI OT outbox on agent_end.
 *
 * Install: add this file path to `.pi/settings.json` → `extensions`.
 * Requires OPENTRONS_PLUGIN_ROOT and OPENTRONS_SESSION_ID in the environment.
 *
 * Experimental — verify against your Pi / @mariozechner/pi-coding-agent version.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExtensionContext = {
  sendMessage: (text: string, options?: { triggerTurn?: boolean }) => Promise<void>;
  ui?: { notify: (message: string, level?: string) => void };
};

type ExtensionAPI = {
  on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => void;
};

export default function register(pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    const root = process.env.OPENTRONS_PLUGIN_ROOT;
    if (!root) {
      return;
    }
    const session = process.env.OPENTRONS_SESSION_ID || "default";
    try {
      const { stdout } = await execFileAsync(
        "node",
        [
          `${root}/scripts/consume-runtime-outbox.mjs`,
          "--host",
          "piagent",
          "--session-id",
          session,
          "--format",
          "json",
          "--ack",
        ],
        { env: process.env },
      );
      const payload = JSON.parse(stdout.trim());
      if (payload.action === "wake" && payload.prompt) {
        await ctx.sendMessage(payload.prompt, { triggerTurn: true });
      }
    } catch (error: unknown) {
      const code = (error as { code?: number | string })?.code;
      if (code === 2) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify(`outbox consume: ${message}`, "warning");
    }
  });
}
