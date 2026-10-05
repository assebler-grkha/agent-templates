#!/usr/bin/env bash
# Установщик бандла agent-templates (клонируй репо -> запусти этот скрипт -> вуаля).
# Тот же план, что и scripts/install.ps1: prerequisites, стабильный рантайм
# ~/.agent-templates, хук Antigravity, плагины и скиллы OpenCode, merge MCP aislop+agentdb,
# самопроверка. Без set -e: шаги предупреждают, а не роняют установку.
#
#   git clone <repo-url> agent-bundle
#   bash agent-bundle/scripts/install.sh [--skip-verify]
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/.agent-templates}"
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=1 ;;
    *) echo "Неизвестный флаг: $arg" >&2; exit 2 ;;
  esac
done

ISSUES=()
warn() { echo "ПРЕДУПРЕЖДЕНИЕ: $1" >&2; ISSUES+=("$1"); }

# Рабочий python: первый кандидат, проходящий `-c pass`
# (в Git Bash `python3` бывает заглушкой Microsoft Store).
probe_py() {
  local c
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'pass' >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

echo "== [0/6] Prerequisites =="
command -v git >/dev/null 2>&1 || warn "git не найден: init-скрипты пропустят git-секцию (маркер AGENT_INIT_GIT_SKIPPED)."
PY="$(probe_py)" || { warn "Рабочий python не найден: хук Antigravity не сможет запускаться."; PY=""; }
command -v node >/dev/null 2>&1 || warn "node не найден: MCP aislop и TS-плагины OpenCode не запустятся."
if command -v rtk >/dev/null 2>&1; then
  RV="$(rtk --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -z "$RV" ]; then
    warn "Не удалось распознать версию rtk."
  elif [ "$(printf '%s\n%s\n' "0.23.0" "$RV" | sort -V | head -1)" != "0.23.0" ]; then
    warn "rtk $RV < 0.23.0: плагин rtk.ts требует >= 0.23.0."
  else
    echo "rtk OK: $RV"
  fi
else
  warn "rtk не найден в PATH: плагин rtk.ts самоотключится (graceful). Доставьте rtk для экономии токенов."
fi

echo "== [1/6] Runtime -> $RUNTIME_DIR =="
mkdir -p "$RUNTIME_DIR/scripts" "$RUNTIME_DIR/tools/aislop/dist"
HOOK_SRC="$REPO_ROOT/scripts/hook-pre-invocation.py"
[ -f "$HOOK_SRC" ] || { echo "ОШИБКА: в бандле нет хука: $HOOK_SRC" >&2; exit 1; }
for f in hook-pre-invocation.py init-workspace.ps1 init-workspace.sh register-agentdb-domain.py; do
  [ -f "$REPO_ROOT/scripts/$f" ] && cp -f "$REPO_ROOT/scripts/$f" "$RUNTIME_DIR/scripts/$f"
done
[ -f "$REPO_ROOT/tools/aislop/dist/mcp.js" ] || { echo "ОШИБКА: aislop dist не собран в бандле (соберите tools/aislop)." >&2; exit 1; }
cp -rf "$REPO_ROOT/tools/aislop/dist/." "$RUNTIME_DIR/tools/aislop/dist/"
[ -f "$REPO_ROOT/tools/aislop/package.json" ] && cp -f "$REPO_ROOT/tools/aislop/package.json" "$RUNTIME_DIR/tools/aislop/"
if [ -f "$REPO_ROOT/tools/agentdb/server.py" ]; then
  mkdir -p "$RUNTIME_DIR/tools/agentdb"
  for f in server.py requirements.txt mcp.json; do
    [ -f "$REPO_ROOT/tools/agentdb/$f" ] && cp -f "$REPO_ROOT/tools/agentdb/$f" "$RUNTIME_DIR/tools/agentdb/$f"
  done
  if [ -n "$PY" ]; then
    "$PY" -c "import fastmcp" 2>/dev/null || "$PY" -m pip install -r "$RUNTIME_DIR/tools/agentdb/requirements.txt" 2>/dev/null || warn "fastmcp не установлен: MCP agentdb не запустится (pip install -r $RUNTIME_DIR/tools/agentdb/requirements.txt)."
  fi
else
  echo "WARNING: AgentDB server missing in bundle, MCP agentdb skipped: $REPO_ROOT/tools/agentdb" >&2
fi
# Init templates: init-workspace.* resolves them from BASE_DIR (== runtime root),
# so the runtime needs rules/ and workspaces/ too, not just scripts/.
for d in rules workspaces; do
  if [ -d "$REPO_ROOT/$d" ]; then
    rm -rf "$RUNTIME_DIR/$d"
    cp -r "$REPO_ROOT/$d" "$RUNTIME_DIR/$d"
  else
    echo "WARNING: template dir missing in bundle, init will fail loudly: $REPO_ROOT/$d" >&2
  fi
done
HOOK_SCRIPT="$RUNTIME_DIR/scripts/hook-pre-invocation.py"
MCP_JS="$RUNTIME_DIR/tools/aislop/dist/mcp.js"
AGENTDB_SERVER="$RUNTIME_DIR/tools/agentdb/server.py"
echo "Runtime OK."

# Дальше нужен python для JSON-merge; без него merge пропускаем с предупреждением.
if [ -z "$PY" ]; then
  warn "JSON-merge (hooks.json, opencode.json) пропущен: нет рабочего python. Поставьте python и запустите снова."
else
echo "== [2/6] Antigravity hook =="
mkdir -p "$HOME/.gemini/config"
HOOKS_FILE="$HOME/.gemini/config/hooks.json"
"$PY" - "$HOOKS_FILE" "$HOOK_SCRIPT" <<'EOF'
import json, sys
hooks_file, hook_script = sys.argv[1], sys.argv[2]
try:
    with open(hooks_file, encoding="utf-8") as f:
        hooks = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    hooks = {}
hooks["workspace-auto-init"] = {
    "enabled": True,
    "PreInvocation": [{
        "type": "command",
        "command": 'python "%s"' % hook_script,
        "timeout": 20,
    }],
}
with open(hooks_file, "w", encoding="utf-8") as f:
    json.dump(hooks, f, ensure_ascii=False, indent=2)
EOF
echo "Hook -> $HOOKS_FILE"
fi

echo "== [3/6] OpenCode plugins =="
mkdir -p "$HOME/.config/opencode/plugins"
DEPLOYED_PLUGINS=()
for f in "$REPO_ROOT"/plugins/opencode/*.ts; do
  [ -e "$f" ] || continue
  cp -f "$f" "$HOME/.config/opencode/plugins/$(basename "$f")"
  DEPLOYED_PLUGINS+=("$(basename "$f")")
done
echo "Plugins -> $HOME/.config/opencode/plugins : ${DEPLOYED_PLUGINS[*]}"

echo "== [4/6] Skills =="
mkdir -p "$HOME/.config/opencode/skills" "$HOME/.gemini/config/skills"
DEPLOYED_SKILLS=()
for d in "$REPO_ROOT"/skills/*/; do
  name="$(basename "$d")"
  [ "$name" = "_skill_template" ] && continue
  [ -f "$d/SKILL.md" ] || continue
  for target in "$HOME/.config/opencode/skills" "$HOME/.gemini/config/skills"; do
    rm -rf "$target/$name"
    cp -r "$d" "$target/$name"
  done
  DEPLOYED_SKILLS+=("$name")
done
echo "Skills -> opencode + gemini : ${DEPLOYED_SKILLS[*]}"

if [ -n "$PY" ]; then
echo "== [5/6] OpenCode MCP (aislop+agentdb) =="
mkdir -p "$HOME/.config/opencode"
OC_JSON="$HOME/.config/opencode/opencode.json"
"$PY" - "$OC_JSON" "$MCP_JS" "$AGENTDB_SERVER" <<'EOF'
import json, os, sys
oc_file, mcp_js, agentdb_server = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(oc_file, encoding="utf-8") as f:
        oc = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    oc = {}
oc.setdefault("mcp", {})["aislop"] = {
    "type": "local",
    "command": ["node", mcp_js],
    "enabled": True,
    "timeout": 30000,
}
if os.path.isfile(agentdb_server):
    oc["mcp"]["agentdb"] = {
        "type": "local",
        "command": ["python", agentdb_server],
        "enabled": True,
        "timeout": 30000,
    }
    print("MCP agentdb -> %s" % oc_file)
with open(oc_file, "w", encoding="utf-8") as f:
    json.dump(oc, f, ensure_ascii=False, indent=2)
EOF
echo "MCP aislop -> $OC_JSON"
echo "Примечание: MCP codebase-memory-mcp внешний (ставится отдельно), бандл его не разворачивает."
fi

if [ "$SKIP_VERIFY" -eq 0 ]; then
echo "== [6/6] Verify =="
CORE_FAIL=()
[ -f "$HOOK_SCRIPT" ] || CORE_FAIL+=("Отсутствует рантайм-файл: $HOOK_SCRIPT")
[ -f "$MCP_JS" ] || CORE_FAIL+=("Отсутствует рантайм-файл: $MCP_JS")
[ -f "$AGENTDB_SERVER" ] || CORE_FAIL+=("Отсутствует рантайм-файл: $AGENTDB_SERVER")
if [ -n "$PY" ]; then
  OUT="$(echo '{}' | "$PY" "$HOOK_SCRIPT" 2>/dev/null)"
  RC=$?
  case "$OUT" in
    *injectSteps*) echo "Hook self-test OK." ;;
    *) CORE_FAIL+=("Hook self-test провален (RC=$RC, out=${OUT:0:60}).") ;;
  esac
  [ "$RC" -ne 0 ] && CORE_FAIL+=("Hook self-test: ненулевой RC=$RC.")
else
  echo "Hook self-test пропущен: нет python." >&2
fi
if [ "${#CORE_FAIL[@]}" -gt 0 ]; then
  printf '%s\n' "${CORE_FAIL[@]}" >&2
  exit 1
fi
fi

echo ""
if [ "${#ISSUES[@]}" -eq 0 ]; then
  echo "Вуаля: бандл установлен, все проверки зеленые. Перезапустите Antigravity / OpenCode."
else
  echo "Установлено с предупреждениями (ядро зеленое):"
  printf '  - %s\n' "${ISSUES[@]}"
  echo "Перезапустите Antigravity / OpenCode."
fi
