import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * OpenCode Auto-Init Plugin.
 * Autonomously checks if the current workspace directory has AGENTS.md / GEMINI.md / CLAUDE.md.
 * If not initialized, runs init-workspace.ps1 and registers the project domain in AgentDB.
 */
export const AutoInitPlugin: Plugin = async ({ directory, $ }) => {
  if (!directory) return {};

  const agentsPath = join(directory, "AGENTS.md");
  const geminiPath = join(directory, "GEMINI.md");
  const claudePath = join(directory, "CLAUDE.md");
  const initScript = "C:/Agent templates/scripts/init-workspace.ps1";

  async function checkAndInit() {
    if (!existsSync(agentsPath) && !existsSync(geminiPath) && !existsSync(claudePath)) {
      const projectName = basename(directory);
      if (existsSync(initScript)) {
        try {
          await $`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${initScript} -TargetPath ${directory} -ProjectName ${projectName}`.quiet().nothrow();
          console.log(`[auto-init] Project '${projectName}' automatically initialized with AGENTS.md, docs, and AgentDB domain.`);
        } catch (err) {
          console.warn(`[auto-init] Error during autonomous workspace init: ${err}`);
        }
      }
    }
  }

  // Initial check on plugin load
  await checkAndInit();

  return {
    "chat.message": async () => {
      // Fallback check before first message
      await checkAndInit();
    },
  };
};
