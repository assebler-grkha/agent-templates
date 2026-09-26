#!/usr/bin/env bash
# init-workspace.sh — Bash-порт scripts/init-workspace.ps1 для Linux/macOS
# (и для Windows-машин с Git Bash, где нет PowerShell).
#
# Повторяет секции .ps1 1-в-1:
#   1. структура папок docs/ + scratch/
#   2. развертывание документации, индексов и шаблонов
#   3. генерация файла правил (AGENTS.md / GEMINI.md / CLAUDE.md)
#   4. файловая гигиена (.gitignore, .dockerignore, .env.example, README.md)
#   5. регистрация домена проекта в AgentDB
#   6. git init/commit/remote (с guard при отсутствии git + маркер
#      AGENT_INIT_GIT_SKIPPED в stdout для хука PreInvocation)
#
# Без set -e: необязательный шаг предупреждает, но не роняет весь скрипт.

TARGET_PATH="."
PROJECT_NAME=""
PROJECT_STACK="TypeScript/Node"
RULE_TYPE="agents"
USE_DYNAMIC="true"
GIT_REMOTE_URL=""

usage() {
    echo "Usage: init-workspace.sh [options]"
    echo "  -t, --target-path PATH     целевой проект (по умолчанию: .)"
    echo "  -n, --project-name NAME    имя проекта (по умолчанию: имя папки)"
    echo "  -s, --project-stack STACK  стек (по умолчанию: TypeScript/Node)"
    echo "  -r, --rule-type TYPE       agents|gemini|claude (по умолчанию: agents)"
    echo "      --use-dynamic BOOL     true|false (по умолчанию: true)"
    echo "  -u, --git-remote-url URL   remote origin (по умолчанию: пусто)"
}

while [ $# -gt 0 ]; do
    case "$1" in
        -t|--target-path)    TARGET_PATH="$2"; shift 2 ;;
        -n|--project-name)   PROJECT_NAME="$2"; shift 2 ;;
        -s|--project-stack)  PROJECT_STACK="$2"; shift 2 ;;
        -r|--rule-type)      RULE_TYPE="$2"; shift 2 ;;
        --use-dynamic)       USE_DYNAMIC="$2"; shift 2 ;;
        -u|--git-remote-url) GIT_REMOTE_URL="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$RULE_TYPE" in
    agents|gemini|claude) ;;
    *) echo "rule-type must be one of: agents, gemini, claude" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"

mkdir -p "$TARGET_PATH" || exit 1
RESOLVED_TARGET="$(cd "$TARGET_PATH" && pwd)"

if [ -z "$PROJECT_NAME" ]; then
    PROJECT_NAME="$(basename "$RESOLVED_TARGET")"
fi

TODAY="$(date +%F)"

echo "=========================================================="
echo " Инициализация рабочего пространства для ИИ-агентов        "
echo " Проект: $PROJECT_NAME | Стек: $PROJECT_STACK"
echo " Целевой путь: $RESOLVED_TARGET"
echo "=========================================================="

# 1. Создание полной структуры папок по Канону
for dir in \
    "docs/architecture" \
    "docs/decisions" \
    "docs/specs/ui" \
    "docs/specs/api" \
    "docs/plans" \
    "docs/guides" \
    "docs/templates" \
    "docs/archive" \
    "scratch" \
; do
    mkdir -p "$RESOLVED_TARGET/$dir"
done
echo "  [+] Создана структура папок docs/ и лаборатория scratch/"

# 2. Развертывание документации, индексов и шаблонов
MINIMAL="$BASE_DIR/workspaces/minimal-agentic"
DOCS_DIR="$RESOLVED_TARGET/docs"

copy_if_missing() {
    # $1 = src, $2 = dst
    if [ -f "$1" ] && [ ! -e "$2" ]; then
        cp "$1" "$2"
        echo "  [+] Развернут документ: $(basename "$2")"
    fi
}

copy_if_missing "$MINIMAL/docs/architecture/overview.md"            "$DOCS_DIR/architecture/overview.md"
copy_if_missing "$MINIMAL/docs/decisions/0001-initial-architecture.md" "$DOCS_DIR/decisions/0001-initial-architecture.md"
copy_if_missing "$MINIMAL/docs/navigation-index.md"                 "$DOCS_DIR/navigation-index.md"
copy_if_missing "$MINIMAL/docs/notes-index.md"                      "$DOCS_DIR/notes-index.md"

# Копирование шаблонов спек и планов
if [ -d "$MINIMAL/docs/templates" ]; then
    for tmpl in "$MINIMAL/docs/templates"/*; do
        [ -f "$tmpl" ] || continue
        dest="$DOCS_DIR/templates/$(basename "$tmpl")"
        if [ ! -e "$dest" ]; then
            cp "$tmpl" "$dest"
        fi
    done
    echo "  [+] Развернуты шаблоны спецификаций в docs/templates/"
fi

# Экранирование значения для правой части sed-замены (разделитель |)
sed_escape() {
    printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# 3. Развертывание файла правил (AGENTS.md / GEMINI.md / CLAUDE.md)
case "$RULE_TYPE" in
    agents) RULE_FILE="AGENTS.md"; DYNAMIC_TEMPLATE="DYNAMIC_AGENTS.template.md" ;;
    gemini) RULE_FILE="GEMINI.md"; DYNAMIC_TEMPLATE="DYNAMIC_GEMINI.template.md" ;;
    claude) RULE_FILE="CLAUDE.md"; DYNAMIC_TEMPLATE="DYNAMIC_CLAUDE.template.md" ;;
esac
TARGET_RULE_FILE="$RESOLVED_TARGET/$RULE_FILE"

if [ "$USE_DYNAMIC" = "true" ]; then
    DYNAMIC_TEMPLATE_PATH="$BASE_DIR/rules/$DYNAMIC_TEMPLATE"
    if [ -f "$DYNAMIC_TEMPLATE_PATH" ]; then
        sed -e "s|{{PROJECT_NAME}}|$(sed_escape "$PROJECT_NAME")|g" \
            -e "s|{{PROJECT_STACK}}|$(sed_escape "$PROJECT_STACK")|g" \
            -e "s|{{INIT_DATE}}|$(sed_escape "$TODAY")|g" \
            "$DYNAMIC_TEMPLATE_PATH" > "$TARGET_RULE_FILE"
        echo "  [+] Сгенерирован динамический файл правил: $RULE_FILE (< 3.5 КБ)"
    fi
else
    STATIC_TEMPLATE="$BASE_DIR/rules/${RULE_FILE%.md}.template.md"
    if [ -f "$STATIC_TEMPLATE" ]; then
        cp "$STATIC_TEMPLATE" "$TARGET_RULE_FILE"
        echo "  [+] Развернут файл правил: $RULE_FILE"
    fi
fi

# 4. Файловая гигиена: .gitignore, .dockerignore, .env.example, README.md
copy_if_missing "$MINIMAL/.gitignore.template"  "$RESOLVED_TARGET/.gitignore"
copy_if_missing "$MINIMAL/.dockerignore.template" "$RESOLVED_TARGET/.dockerignore"
copy_if_missing "$MINIMAL/.env.example.template"  "$RESOLVED_TARGET/.env.example"

# Генерация README.md если отсутствует
if [ ! -e "$RESOLVED_TARGET/README.md" ]; then
    README_TEMPLATE="$MINIMAL/README.template.md"
    if [ -f "$README_TEMPLATE" ]; then
        sed -e "s|{{PROJECT_NAME}}|$(sed_escape "$PROJECT_NAME")|g" \
            -e "s|{{PROJECT_DESCRIPTION}}|$(sed_escape "Рабочий проект с архитектурными стандартами и поддержкой ИИ-агентов.")|g" \
            -e "s|{{LANG_RUNTIME}}|$(sed_escape "Node.js 22+ / Python 3.11+")|g" \
            -e "s|{{FRAMEWORK}}|$(sed_escape "$PROJECT_STACK")|g" \
            -e "s|{{DATABASE_ORM}}|$(sed_escape "PostgreSQL / SQLite")|g" \
            "$README_TEMPLATE" > "$RESOLVED_TARGET/README.md"
        echo "  [+] Создан витринный README.md"
    fi
fi

# 5. Автономная регистрация домена проекта в AgentDB
REGISTER_SCRIPT="$SCRIPT_DIR/register-agentdb-domain.py"
if [ -f "$REGISTER_SCRIPT" ]; then
    echo "  [*] Регистрация домена проекта в AgentDB..."
    # NOTE: on some systems (e.g. Git Bash on Windows) python3 may be a
    # broken store stub: pick the first candidate that actually runs.
    PYTHON_CMD=""
    for c in python3 python; do
        if command -v "$c" >/dev/null 2>&1 && "$c" -c 'pass' >/dev/null 2>&1; then
            PYTHON_CMD="$(command -v "$c")"
            break
        fi
    done
    if [ -z "$PYTHON_CMD" ]; then
        echo "  [!] Python не найден, пропуск регистрации AgentDB."
    else
        REG_OUTPUT="$("$PYTHON_CMD" "$REGISTER_SCRIPT" --project "$PROJECT_NAME" --path "$RESOLVED_TARGET" --stack "$PROJECT_STACK" 2>&1)"
        REG_CODE=$?
        if [ "$REG_CODE" -ne 0 ]; then
            echo "  [!] Предупреждение регистрации AgentDB: $REG_OUTPUT"
        else
            echo "  $REG_OUTPUT"
        fi
    fi
fi

# 6. Обязательная инициализация Git и подключение к Remote
# Git может отсутствовать на машине: тогда секция пропускается целиком,
# а хук PreInvocation напомнит агенту предложить установку (маркер ниже).
if ! command -v git >/dev/null 2>&1; then
    echo "  [!] Git не найден в PATH: шаги git init/commit/remote пропущены. Установите git и выполните их вручную."
    printf 'AGENT_INIT_GIT_SKIPPED\n'
else
    if [ ! -d "$RESOLVED_TARGET/.git" ]; then
        echo "  [*] Инициализация Git-репозитория..."
        git -C "$RESOLVED_TARGET" init -b main >/dev/null
        git -C "$RESOLVED_TARGET" add . >/dev/null
        # Коммит не должен ронять весь скрипт при отсутствии identity/изменений
        if git -C "$RESOLVED_TARGET" commit -m "chore: initial project scaffold, rules, and docs" >/dev/null 2>&1; then
            echo "  [+] Git репозиторий инициализирован, создан первый коммит в ветке 'main'"
        else
            echo "  [!] Git commit пропущен (проверьте user.name/user.email): файлы проиндексированы через 'git add'."
        fi
    else
        git -C "$RESOLVED_TARGET" add . >/dev/null
        git -C "$RESOLVED_TARGET" commit -m "chore: update agent workspace templates and rules" -q >/dev/null 2>&1 || true
    fi

    if [ -n "$GIT_REMOTE_URL" ]; then
        echo "  [*] Подключение к remote: $GIT_REMOTE_URL"
        if git -C "$RESOLVED_TARGET" remote | grep -qx "origin"; then
            git -C "$RESOLVED_TARGET" remote set-url origin "$GIT_REMOTE_URL"
        else
            git -C "$RESOLVED_TARGET" remote add origin "$GIT_REMOTE_URL"
        fi
        echo "  [+] Remote 'origin' успешно настроен: $GIT_REMOTE_URL"
    else
        echo "  [!] ВНИМАНИЕ: Git Remote URL не указан. Агент обязан запросить данные для подключения у пользователя."
    fi
fi

echo "==> Workspace '$PROJECT_NAME' полностью подготовлен к работе с агентами!"
