import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

interface InitTarget {
  script: string;
  shell: string;
  psStyle: boolean;
}

function resolveInit(): InitTarget | null {
  // 1. Explicit override via env (handy for tests/non-standard installs)
  const override = process.env.AGENT_INIT_SCRIPT;
  if (override && existsSync(override)) {
    const psStyle = override.toLowerCase().endsWith(".ps1");
    return { script: override, shell: psStyle ? "powershell.exe" : "bash", psStyle };
  }
  // 2. scripts/ dir next to the plugin: plugins/opencode/ -> ../../scripts/
  let dir: string | null = null;
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = join(dirname(here), "..", "..", "scripts");
    if (existsSync(candidate)) dir = candidate;
  } catch {
    // ignore, runtime fallback below
  }
  // 3. Installer runtime copy (~/.agent-templates/scripts/): install.ps1 /
  // install.sh deploy the scripts there, while the plugin file itself is
  // deployed to ~/.config/opencode/plugins/ where the ../../scripts layout
  // above resolves to a nonexistent ~/.config/scripts.
  if (!dir) {
    const runtime = join(homedir(), ".agent-templates", "scripts");
    if (existsSync(runtime)) dir = runtime;
  }
  const ps1 = dir ? join(dir, "init-workspace.ps1") : null;
  const sh = dir ? join(dir, "init-workspace.sh") : null;
  const ps1Exists = ps1 !== null && existsSync(ps1);
  const shExists = sh !== null && existsSync(sh);
  // Windows prefers .ps1; POSIX prefers .sh with pwsh+.ps1 fallback
  if (process.platform === "win32") {
    if (ps1Exists) return { script: ps1, shell: "powershell.exe", psStyle: true };
    if (shExists) return { script: sh, shell: "bash", psStyle: false };
    return null;
  }
  if (shExists) return { script: sh, shell: "bash", psStyle: false };
  if (ps1Exists) return { script: ps1, shell: "pwsh", psStyle: true };
  return null;
}

function normDir(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

function isIgnoredDir(dir: string): boolean {
  if (!dir) return true;
  const norm = normDir(dir);
  // Drive/filesystem roots can never be projects.
  if (norm === "" || norm === "/" || /^[a-z]:$/i.test(norm)) return true;
  // Home directory on any platform: USERPROFILE on Windows, HOME elsewhere.
  // Initializing $HOME would scatter AGENTS.md, docs/, scratch/ and git
  // into the user home directory.
  const homes = new Set(
    [process.env.USERPROFILE, process.env.HOME, homedir()]
      .filter((h): h is string => !!h)
      .map((h) => normDir(h)),
  );
  if (homes.has(norm)) return true;
  // Bundle runtime dir (~/.agent-templates): installer working copy,
  // never a project.
  const runtime = normDir(homedir() + "/.agent-templates");
  if (norm === runtime || norm.startsWith(runtime + "/")) return true;
  return false;
}

function runInitScript(target: InitTarget, targetPath: string, projectName: string, timeoutMs = 60000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { code: number; stdout: string; stderr: string }) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
    };
    const args = target.psStyle
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target.script, "-TargetPath", targetPath, "-ProjectName", projectName]
      : [target.script, "-t", targetPath, "-n", projectName];
    const child = spawn(target.shell, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      done({ code: -2, stdout, stderr: `${stderr}\n[auto-init] timeout ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    // biome-ignore lint: timer ref unref for Bun/Node compatibility
    (timer as unknown as { unref?: () => void }).unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      done({ code: -1, stdout, stderr: err.message });
    });

    child.on("close", (code) => {
      done({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * OpenCode Auto-Init Plugin.
 * Autonomously checks if the current workspace directory has AGENTS.md / GEMINI.md / CLAUDE.md.
 * If not initialized, runs init-workspace.ps1/.sh and registers the project domain in AgentDB.
 * Works seamlessly in:
 * - OpenCode CLI (Bun runtime)
 * - OpenCode Desktop (Electron/Node.js runtime where Bun.$ is undefined)
 * - Session creation/update events
 */
export const AutoInitPlugin: Plugin = async ({ directory }) => {
  const init = resolveInit();
  // Кэш проверенных директорий + guard от параллельных запусков
  const checked = new Set<string>();
  const inFlight = new Set<string>();
  const failedAt = new Map<string, number>();
  const FAILED_RETRY_MS = 60 * 60 * 1000; // one retry per hour, not per event

  function extractSessionDir(event: unknown): string | undefined {
    const p = (event as any)?.properties;
    return (
      p?.info?.directory ??
      p?.directory ??
      (event as any)?.directory ??
      undefined
    );
  }

  async function checkAndInit(targetDir: string | undefined | null) {
    if (!targetDir || isIgnoredDir(targetDir)) return;
    if (checked.has(targetDir) || inFlight.has(targetDir)) return;

    const agentsPath = join(targetDir, "AGENTS.md");
    const geminiPath = join(targetDir, "GEMINI.md");
    const claudePath = join(targetDir, "CLAUDE.md");

    if (!existsSync(agentsPath) && !existsSync(geminiPath) && !existsSync(claudePath)) {
      const projectName = basename(targetDir);
      if (init) {
        const lastFail = failedAt.get(targetDir) ?? 0;
        if (Date.now() - lastFail < FAILED_RETRY_MS) return;
        inFlight.add(targetDir);
        try {
          const res = await runInitScript(init, targetDir, projectName);
          if (res.code === 0) {
            console.log(`[auto-init] Project '${projectName}' automatically initialized with AGENTS.md, docs, and AgentDB domain.`);
            failedAt.delete(targetDir);
            checked.add(targetDir);
          } else {
            console.warn(`[auto-init] Project '${projectName}' initialization failed with code ${res.code}: ${res.stderr || res.stdout}`);
            failedAt.set(targetDir, Date.now());
          }
        } catch (err) {
          console.warn(`[auto-init] Error during autonomous workspace init: ${err}`);
            failedAt.set(targetDir, Date.now());
        } finally {
          inFlight.delete(targetDir); // checked only on success below
        }
      } else {
        console.warn(`[auto-init] Init script not found for this platform (checked repo scripts/ and ~/.agent-templates/scripts; set AGENT_INIT_SCRIPT to override)`);
        checked.add(targetDir);
      }
    } else {
      checked.add(targetDir);
    }
  }

  // 1. Initial check on plugin load for directory provided at startup
  await checkAndInit(directory);

  return {
    // 2. React to session lifecycle events. `session.created` fires once per
    // session; `session.updated` covers subsequent activity. Both are
    // guarded by `checked`/`inFlight`, so repeats are no-ops.
    // NOTE: there is no `chat.message` event in the OpenCode plugin API
    // (verified against the live event log) — do not re-add it.
    event: async ({ event }) => {
      if (event?.type === "session.created" || event?.type === "session.updated") {
        const sessionDir = extractSessionDir(event);
        if (sessionDir) {
          await checkAndInit(sessionDir);
        }
      }
    },
  };
};

// v1 module form: `id` is shown in the OpenCode UI instead of the file path.
// The named export is kept so older hosts can still load the legacy path.
const AutoInitModule = { id: "auto-init", server: AutoInitPlugin } satisfies PluginModule;

export default AutoInitModule;
