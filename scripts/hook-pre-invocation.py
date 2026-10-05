import contextlib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

# Ensure UTF-8 I/O on Windows consoles
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def is_ignored_dir(path: str) -> bool:
    if not path:
        return True
    norm = os.path.normpath(path).lower().rstrip("\\/")
    # Root drive check (e.g. "c:", "c:\")
    drive, rest = os.path.splitdrive(norm)
    if not rest or rest in ("\\", "/"):
        return True
    # Home directory on any platform: USERPROFILE on Windows, HOME/~
    # elsewhere. Initializing $HOME would scatter AGENTS.md, docs/,
    # scratch/ and git into the user home directory.
    _sep = chr(92) + "/"
    homes = {
        os.path.normpath(h).lower().rstrip(_sep)
        for h in (
            os.environ.get("USERPROFILE", ""),
            os.environ.get("HOME", ""),
            os.path.expanduser("~"),
        )
        if h and h != "~"
    }
    if norm in homes:
        return True
    # Bundle runtime dir (~/.agent-templates): installer working copy,
    # never a project.
    runtime = (
        os.path.normpath(os.path.join(os.path.expanduser("~"), ".agent-templates"))
        .lower()
        .rstrip(_sep)
    )
    if (
        norm == runtime
        or norm.startswith(runtime + chr(92))
        or norm.startswith(runtime + "/")
    ):
        return True
    return False


BACKOFF_TTL_SECONDS = 24 * 3600

# Ephemeral notice for initialized workspaces on machines without git.
# Never persisted to rule files: it vanishes on its own once git appears.
GIT_MISSING_NOTICE = (
    "[Auto-Init Notice] В проекте есть правила, но на этой машине не найден git: "
    "шаги git init/commit/remote при инициализации были пропущены. "
    "Предложи пользователю установить git, затем выполни git init -b main, "
    "первый коммит и подключение remote вручную."
)


def _backoff_path(target_dir: str) -> str:
    digest = hashlib.sha1(
        os.path.normpath(target_dir).encode("utf-8", "replace")
    ).hexdigest()[:16]
    return os.path.join(
        tempfile.gettempdir(), f"agent-templates-auto-init-{digest}.marker"
    )


def backoff_active(target_dir: str) -> bool:
    try:
        mtime = os.path.getmtime(_backoff_path(target_dir))
    except OSError:
        return False
    return (time.time() - mtime) < BACKOFF_TTL_SECONDS


def backoff_mark(target_dir: str) -> None:
    # Best-effort marker: an unwritable temp dir must never break the hook.
    with contextlib.suppress(OSError):
        with open(_backoff_path(target_dir), "w", encoding="utf-8") as fh:
            fh.write(str(int(time.time())))


def backoff_clear(target_dir: str) -> None:
    # Best-effort cleanup, same rationale as backoff_mark.
    with contextlib.suppress(OSError):
        os.remove(_backoff_path(target_dir))


def select_init_command(script_dir: str, target_dir: str, project_name: str):
    """Choose the platform init script.

    Windows prefers init-workspace.ps1 (powershell.exe/pwsh);
    POSIX prefers init-workspace.sh (bash/sh) with pwsh+.ps1 fallback.
    Returns (cmd, label) or (None, searched_paths) when nothing is usable.
    """
    ps1 = os.path.join(script_dir, "init-workspace.ps1")
    sh = os.path.join(script_dir, "init-workspace.sh")
    ps_args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1,
        "-TargetPath",
        target_dir,
        "-ProjectName",
        project_name,
    ]
    sh_args = [sh, "-t", target_dir, "-n", project_name]
    if os.name == "nt":
        if os.path.exists(ps1):
            shell = (
                shutil.which("powershell.exe")
                or shutil.which("pwsh")
                or "powershell.exe"
            )
            return ([shell] + ps_args, "init-workspace.ps1")
        shell = shutil.which("bash")
        if shell and os.path.exists(sh):
            return ([shell] + sh_args, "init-workspace.sh")
        return (None, ps1 + " / " + sh)
    if os.path.exists(sh):
        shell = shutil.which("bash") or shutil.which("sh")
        if shell:
            return ([shell] + sh_args, "init-workspace.sh")
    if os.path.exists(ps1):
        shell = shutil.which("pwsh")
        if shell:
            return ([shell] + ps_args, "init-workspace.ps1")
    return (None, sh + " / " + ps1)


def main():
    try:
        raw_input = sys.stdin.read()
        cleaned = raw_input.strip().lstrip("\ufeff")
        payload = json.loads(cleaned) if cleaned else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Fallback to empty response if invalid input
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    workspace_paths = payload.get("workspacePaths", [])
    if not workspace_paths:
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    # PreInvocation fires before EVERY model call. Run the expensive init
    # only on the first invocation; later turns are silent no-ops.
    # (Missing key = older contract: proceed as before.)
    invocation_num = payload.get("invocationNum")
    if invocation_num is not None and invocation_num != 0:
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    # Multi-root: init the first non-ignored root that lacks rule files.
    # Each root is an independent project and gets its own turn.
    targets = [
        os.path.normpath(p) for p in workspace_paths if p and not is_ignored_dir(p)
    ]
    if not targets:
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    rule_files = ("AGENTS.md", "GEMINI.md", "CLAUDE.md")
    pending = [
        d
        for d in targets
        if not any(os.path.exists(os.path.join(d, rf)) for rf in rule_files)
    ]
    if not pending:
        # Workspace is initialized. The only machine-state check that still
        # makes sense here: git binary missing (init skips git steps then).
        if shutil.which("git") is None:
            sys.stdout.write(
                json.dumps({"injectSteps": [{"ephemeralMessage": GIT_MISSING_NOTICE}]})
            )
            return
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return
    target_dir = pending[0]

    if backoff_active(target_dir):
        # A recent attempt already failed — stay silent instead of
        # injecting the same error before every model call.
        sys.stdout.write(json.dumps({"injectSteps": []}))
        return

    # Project is uninitialized: trigger the platform init script (.ps1/.sh)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_name = os.path.basename(target_dir)
    backoff_mark(target_dir)
    selected = select_init_command(script_dir, target_dir, project_name)
    if selected[0] is None:
        backoff_clear(target_dir)
        notice = f"[Auto-Init Notice] Обнаружен чистый проект '{project_name}'. Скрипт инициализации не найден: {selected[1]}"
        sys.stdout.write(json.dumps({"injectSteps": [{"ephemeralMessage": notice}]}))
        return
    cmd, script_label = selected
    try:
        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"превышен таймаут 15с при запуске {script_label}")
        if res.returncode != 0:
            err_msg = (
                res.stderr.strip()
                or res.stdout.strip()
                or f"exit code {res.returncode}"
            )
            raise RuntimeError(err_msg)

        git_skipped = "AGENT_INIT_GIT_SKIPPED" in (res.stdout or "")
        message = (
            f"[Autonomous Auto-Init] Проект '{project_name}' успешно инициализирован до первого шага: "
            f"созданы AGENTS.md, docs/, навигационные индексы и домен в AgentDB."
            + (
                " Git на этой машине не найден: шаги git init/commit/remote пропущены. "
                "Предложи пользователю установить git."
                if git_skipped
                else " Git-репозиторий и remote настроены."
            )
        )
        backoff_clear(target_dir)
        sys.stdout.write(json.dumps({"injectSteps": [{"ephemeralMessage": message}]}))
    except Exception as err:
        backoff_mark(target_dir)
        notice = f"[Auto-Init Notice] Обнаружен чистый проект '{project_name}'. Ошибка автоинициализации: {err}"
        sys.stdout.write(json.dumps({"injectSteps": [{"ephemeralMessage": notice}]}))


if __name__ == "__main__":
    main()
