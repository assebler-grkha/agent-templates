import argparse
import datetime
import json
import os
import sqlite3
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ANTIGRAVITY_DIR = r"C:\Users\Gregory\.gemini\agentdb_sync"
ANTIGRAVITY_DB = os.path.join(ANTIGRAVITY_DIR, "agent_memory.db")
OPENCODE_DB = r"C:\Users\Gregory\.opencode-mcp\pathfinder-app\.agentdb\pathfinder.db"


def sync_git_repo(repo_dir: str, message: str) -> None:
    git_dir = os.path.join(repo_dir, ".git")
    if not os.path.isdir(git_dir):
        return

    try:
        res_add = subprocess.run(
            ["git", "add", "."],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if res_add.returncode != 0:
            sys.stderr.write(f"Git add warning: {res_add.stderr}\n")
            return

        subprocess.run(
            ["git", "commit", "-m", message],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as err:
        sys.stderr.write(f"Git sync warning: {err}\n")


def register_project_domain(
    project_name: str, project_path: str, stack: str, desc: str = ""
) -> bool:
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    key = f"{project_name}_init_meta"
    content = (
        f"Проект '{project_name}' инициализирован.\n"
        f"- Путь: {project_path}\n"
        f"- Стек: {stack}\n"
        f"- Описание: {desc or 'Базовый рабочий проект'}\n"
        f"- Дата инициализации: {now_iso}"
    )
    registered_any = False

    # 1. Запись в Antigravity agent_memory.db
    if os.path.exists(ANTIGRAVITY_DB):
        try:
            with sqlite3.connect(ANTIGRAVITY_DB) as conn:
                c = conn.cursor()
                c.execute(
                    """
                    INSERT INTO memories (key, content, category, project, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        content = excluded.content,
                        updated_at = excluded.updated_at
                    """,
                    (
                        key,
                        content,
                        "project_domain",
                        project_name,
                        now_iso,
                        now_iso,
                    ),
                )
                conn.commit()
            print(
                f"[AgentDB/Antigravity] Домен '{project_name}' зарегистрирован под ключом '{key}'."
            )
            sync_git_repo(ANTIGRAVITY_DIR, f"init domain for project: {project_name}")
            registered_any = True
        except sqlite3.Error as err:
            sys.stderr.write(f"[AgentDB Error] Ошибка agent_memory.db: {err}\n")

    # 2. Запись в OpenCode pathfinder.db
    if os.path.exists(OPENCODE_DB):
        try:
            metadata_str = json.dumps(
                {
                    "path": project_path,
                    "stack": stack,
                    "category": "project_domain",
                },
                ensure_ascii=False,
            )
            with sqlite3.connect(OPENCODE_DB) as conn:
                c = conn.cursor()
                existing = c.execute(
                    "SELECT id FROM documents WHERE id = ?", (key,)
                ).fetchone()
                if existing:
                    c.execute(
                        "UPDATE documents SET content = ?, metadata = ?, created_at = ? WHERE id = ?",
                        (content, metadata_str, now_iso, key),
                    )
                else:
                    c.execute(
                        "INSERT INTO documents (id, domain, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
                        (key, project_name, content, metadata_str, now_iso),
                    )
                conn.commit()
            print(
                f"[AgentDB/OpenCode] Домен '{project_name}' зарегистрирован в pathfinder.db (id: '{key}')."
            )
            registered_any = True
        except sqlite3.Error as err:
            sys.stderr.write(f"[AgentDB Error] Ошибка pathfinder.db: {err}\n")

    if not registered_any:
        sys.stderr.write("[WARN] Ни одна база данных AgentDB не найдена.\n")
        return False

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Register project domain in AgentDB (Antigravity & OpenCode)"
    )
    parser.add_argument("--project", required=True, help="Project name")
    parser.add_argument("--path", required=True, help="Project absolute path")
    parser.add_argument("--stack", default="TypeScript/Node", help="Tech stack")
    parser.add_argument("--desc", default="", help="Short description")

    args = parser.parse_args()
    success = register_project_domain(args.project, args.path, args.stack, args.desc)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
