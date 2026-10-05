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
STACK_GIVEN=0
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
        -s|--project-stack)  PROJECT_STACK="$2"; STACK_GIVEN=1; shift 2 ;;
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

# Детект стека по маркерам: явный -s побеждает, иначе маркеры файлов,
# иначе честное TBD (README-шаблон не должен врать на пустой папке).
DETECTED_LANG=""; DETECTED_MARKER=""
for m in "package.json:Node.js" "pyproject.toml:Python" "requirements.txt:Python" "setup.py:Python" "go.mod:Go" "Cargo.toml:Rust"; do
    f="${m%%:*}"; l="${m##*:}"
    if [ -e "$RESOLVED_TARGET/$f" ]; then DETECTED_LANG="$l"; DETECTED_MARKER="$f"; break; fi
done
stack_family() {
    case "$1" in
        *Node*|*TypeScript*|*JavaScript*) echo "Node.js" ;;
        *Python*) echo "Python" ;;
        *Go*) echo "Go" ;;
        *Rust*) echo "Rust" ;;
        *) echo "" ;;
    esac
}
if [ "$STACK_GIVEN" = "1" ]; then STACK_FAMILY="$(stack_family "$PROJECT_STACK")"; else STACK_FAMILY="$DETECTED_LANG"; fi
README_LANG="TBD"; README_FRAMEWORK="TBD"; README_DB="TBD"
README_DESCRIPTION="Каркас рабочей директории кодинг-агента. Стек не определён — заполни разделы TODO ниже."
if [ "$STACK_GIVEN" = "1" ] && [ -n "$PROJECT_STACK" ]; then README_FRAMEWORK="$PROJECT_STACK"; fi
if [ -n "$DETECTED_LANG" ]; then
    README_LANG="$DETECTED_LANG (маркер: $DETECTED_MARKER)"
    if [ "$STACK_GIVEN" != "1" ]; then README_FRAMEWORK="$DETECTED_LANG"; fi
    README_DESCRIPTION="Рабочий проект с архитектурными стандартами и поддержкой ИИ-агентов."
fi

# Инжектируемые блоки README: вариант под стек либо TODO-чеклист.
QS_TMP="$(mktemp)"; CMD_TMP="$(mktemp)"
case "$STACK_FAMILY" in
Node.js)
cat > "$QS_TMP" <<'EOF'
1. Скопируй `.env.example` в `.env` и заполни секреты:
   ```bash
   cp .env.example .env
   ```
2. Установи зависимости и прогони тесты:
   ```bash
   npm install        # или pnpm install
   npm test
   ```
3. Запусти проект:
   ```bash
   npm run dev        # порт — см. конфиг проекта
   ```
EOF
cat > "$CMD_TMP" <<'EOF'
```bash
npm run build      # сборка
npm test           # тесты
npm run lint       # линтер (если настроен)
```
EOF
;;
Python)
cat > "$QS_TMP" <<'EOF'
1. Скопируй `.env.example` в `.env` и заполни секреты:
   ```bash
   cp .env.example .env
   ```
2. Создай окружение, установи зависимости и прогони тесты:
   ```bash
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   python -m pytest
   ```
3. Запусти проект:
   ```bash
   python main.py       # точка входа — уточни под проект
   ```
EOF
cat > "$CMD_TMP" <<'EOF'
```bash
pip install -r requirements.txt  # зависимости
python -m pytest                 # тесты
```
EOF
;;
Go)
cat > "$QS_TMP" <<'EOF'
1. Скопируй `.env.example` в `.env` и заполни секреты:
   ```bash
   cp .env.example .env
   ```
2. Собери и прогони тесты:
   ```bash
   go mod download
   go build ./...
   go test ./...
   ```
EOF
cat > "$CMD_TMP" <<'EOF'
```bash
go build ./...     # сборка
go test ./...      # тесты
```
EOF
;;
Rust)
cat > "$QS_TMP" <<'EOF'
1. Скопируй `.env.example` в `.env` и заполни секреты:
   ```bash
   cp .env.example .env
   ```
2. Собери и прогони тесты:
   ```bash
   cargo build
   cargo test
   ```
EOF
cat > "$CMD_TMP" <<'EOF'
```bash
cargo build        # сборка
cargo test         # тесты
```
EOF
;;
*)
cat > "$QS_TMP" <<'EOF'
> TODO: выбери стек проекта и заполни этот раздел.
>
> - [ ] Определить язык/рантайм и фреймворк, обновить таблицу стека выше
> - [ ] Записать команды установки зависимостей
> - [ ] Записать команды запуска, сборки и тестов
> - [ ] Удалить этот чеклист
EOF
cat > "$CMD_TMP" <<'EOF'
> TODO: команды появятся после выбора стека (см. чеклист выше).
EOF
;;
esac

# Команда тестов и линтеры для шаблонов: вариант под стек либо честное TBD.
TESTCMD="TBD (стек не определён — впиши команду запуска тестов)"
QUALITY="TBD (зафиксируй линтеры проекта)"
case "$STACK_FAMILY" in
Node.js) TESTCMD="npm test"; QUALITY="ESLint / Prettier" ;;
Python) TESTCMD="python -m pytest"; QUALITY="Ruff" ;;
Go) TESTCMD="go test ./..."; QUALITY="gofmt / golangci-lint" ;;
Rust) TESTCMD="cargo test"; QUALITY="rustfmt / clippy" ;;
esac

echo "=========================================================="
echo " Инициализация рабочего пространства для ИИ-агентов        "
echo " Проект: $PROJECT_NAME | Стек: $README_FRAMEWORK"
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
            -e "s|{{TESTCMD}}|$(sed_escape "$TESTCMD")|g" \
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
if [ ! -f "$TARGET_RULE_FILE" ]; then
    echo "ОШИБКА: шаблон правил не найден и файл правил не создан (ищите rules/*.template.md в $BASE_DIR). Отказ от молчаливой частичной инициализации." >&2
    exit 1
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
            -e "s|{{PROJECT_DESCRIPTION}}|$(sed_escape "$README_DESCRIPTION")|g" \
            -e "s|{{LANG_RUNTIME}}|$(sed_escape "$README_LANG")|g" \
            -e "s|{{FRAMEWORK}}|$(sed_escape "$README_FRAMEWORK")|g" \
            -e "s|{{DATABASE_ORM}}|$(sed_escape "$README_DB")|g" \
            -e "s|{{QUALITY}}|$(sed_escape "$QUALITY")|g" \
            -e "/{{QUICKSTART}}/r $QS_TMP" -e "/{{QUICKSTART}}/d" \
            -e "/{{COMMANDS}}/r $CMD_TMP" -e "/{{COMMANDS}}/d" \
            "$README_TEMPLATE" > "$RESOLVED_TARGET/README.md"
        echo "  [+] Создан витринный README.md"
    fi
fi
rm -f "$QS_TMP" "$CMD_TMP"

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
        # Foreign bare `git init` (master branch, zero commits): normalize to
        # main while there is no history to break.
        git -C "$RESOLVED_TARGET" rev-parse --verify HEAD >/dev/null 2>&1 \
            || git -C "$RESOLVED_TARGET" branch -M main >/dev/null 2>&1 || true
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
