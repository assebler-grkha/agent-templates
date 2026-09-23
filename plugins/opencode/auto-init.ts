import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";

function isIgnoredDir(dir: string): boolean {
  if (!dir) return true;
  const norm = dir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const home = (process.env.USERPROFILE || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  if (norm === "" || norm === "/" || /^[a-z]:$/i.test(norm)) return true;
  if (norm === home) return true;
  return false;
}

function runPowerShell(scriptPath: string, targetPath: string, projectName: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-TargetPath",
      targetPath,
      "-ProjectName",
      projectName,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * OpenCode Auto-Init Plugin.
 * Autonomously checks if the current workspace directory has AGENTS.md / GEMINI.md / CLAUDE.md.
 * If not initialized, runs init-workspace.ps1 and registers the project domain in AgentDB.
 * Works seamlessly in:
 * - OpenCode CLI (Bun runtime)
 * - OpenCode Desktop (Electron/Node.js runtime where Bun.$ is undefined)
 * - Session creation events and first-message hooks
 */
export const AutoInitPlugin: Plugin = async ({ client, directory }) => {
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
          const res = await runPowerShell(initScript, targetDir, projectName);
          if (res.code === 0) {
            console.log(`[auto-init] Project '${projectName}' automatically initialized with AGENTS.md, docs, and AgentDB domain.`);
          } else {
            console.warn(`[auto-init] Project '${projectName}' initialization failed with code ${res.code}: ${res.stderr || res.stdout}`);
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
