import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

function isIgnoredDir(dir: string): boolean {
  if (!dir) return true;
  const norm = dir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const home = (process.env.USERPROFILE || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  if (norm === "" || norm === "/" || /^[a-z]:$/i.test(norm)) return true;
  if (norm === home) return true;
  return false;
}

/**
 * OpenCode Auto-Init Plugin.
 * Autonomously checks if the current workspace directory has AGENTS.md / GEMINI.md / CLAUDE.md.
 * If not initialized, runs init-workspace.ps1 and registers the project domain in AgentDB.
 * Supports:
 * - Direct CLI startup in a project directory
 * - Multi-project OpenCode Desktop session switching via 'session.created' events
 * - Fallback check on first chat message via client.session.get()
 */
export const AutoInitPlugin: Plugin = async ({ client, directory, $ }) => {
  const initScript = "C:/Agent templates/scripts/init-workspace.ps1";

  async function checkAndInit(targetDir: string | undefined | null) {
    if (!targetDir || isIgnoredDir(targetDir)) return;

    const agentsPath = join(targetDir, "AGENTS.md");
    const geminiPath = join(targetDir, "GEMINI.md");
    const claudePath = join(targetDir, "CLAUDE.md");

    if (!existsSync(agentsPath) && !existsSync(geminiPath) && !existsSync(claudePath)) {
      const projectName = basename(targetDir);
      if (existsSync(initScript)) {
        try {
          const res = await $`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${initScript} -TargetPath ${targetDir} -ProjectName ${projectName}`.quiet().nothrow();
          if (res.exitCode === 0) {
            console.log(`[auto-init] Project '${projectName}' automatically initialized with AGENTS.md, docs, and AgentDB domain.`);
          } else {
            console.warn(`[auto-init] Project '${projectName}' initialization failed with code ${res.exitCode}: ${res.stderr.toString()}`);
          }
        } catch (err) {
          console.warn(`[auto-init] Error during autonomous workspace init: ${err}`);
        }
      }
    }
  }

  // 1. Initial check on plugin load for directory provided at startup
  await checkAndInit(directory);

  return {
    // 2. React to session creation in OpenCode Desktop
    event: async ({ event }) => {
      if (event?.type === "session.created") {
        const sessionDir = (event as any).properties?.info?.directory;
        if (sessionDir) {
          await checkAndInit(sessionDir);
        }
      }
    },
    // 3. Fallback check on first chat message in a session
    "chat.message": async (input) => {
      try {
        if (input?.sessionID && client?.session?.get) {
          const session = await client.session.get({ path: { id: input.sessionID } });
          const sessionDir = session.data?.directory;
          if (sessionDir) {
            await checkAndInit(sessionDir);
            return;
          }
        }
      } catch {
        // Fallback to initial directory if session lookup fails
      }
      await checkAndInit(directory);
    },
  };
};

export default AutoInitPlugin;
