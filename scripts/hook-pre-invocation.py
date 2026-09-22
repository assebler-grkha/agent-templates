import json
import os
import subprocess
import sys

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def main():
    try:
        raw_input = sys.stdin.read()
        payload = json.loads(raw_input) if raw_input.strip() else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Fallback to empty response if invalid input
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    workspace_paths = payload.get("workspacePaths", [])
    if not workspace_paths:
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    target_dir = os.path.normpath(workspace_paths[0])
    agents_path = os.path.join(target_dir, "AGENTS.md")
    gemini_path = os.path.join(target_dir, "GEMINI.md")
    claude_path = os.path.join(target_dir, "CLAUDE.md")

    # If project already initialized, do nothing
    if (
        os.path.exists(agents_path)
        or os.path.exists(gemini_path)
        or os.path.exists(claude_path)
    ):
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    # Project is uninitialized: trigger init-workspace.ps1
    script_dir = os.path.dirname(os.path.abspath(__file__))
    init_script = os.path.join(script_dir, "init-workspace.ps1")
    project_name = os.path.basename(target_dir)

    try:
        cmd = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            init_script,
            "-TargetPath",
            target_dir,
            "-ProjectName",
            project_name,
        ]
        subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        message = (
            f"[Autonomous Auto-Init] Проект '{project_name}' успешно инициализирован до первого шага: "
            f"созданы AGENTS.md, docs/, навигационные индексы, Git и домен в AgentDB."
        )
        sys.stdout.write(json.dumps({"injectSteps": [{"ephemeralMessage": message}]}))
    except Exception as err:
        notice = f"[Auto-Init Notice] Обнаружен чистый проект '{project_name}'. Инициализируйте правила AGENTS.md. ({err})"
        sys.stdout.write(json.dumps({"injectSteps": [{"ephemeralMessage": notice}]}))


if __name__ == "__main__":
    main()
