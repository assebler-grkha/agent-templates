# Agent Templates Sandbox

[![AI-Agentic Ready](https://img.shields.io/badge/AI--Agentic-Ready-00C7B7?style=flat-square&logo=openai&logoColor=white)](#)
[![Token Efficiency](https://img.shields.io/badge/Context%20Tokens--75%25-brightgreen?style=flat-square)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![MCP Suite](https://img.shields.io/badge/MCP-Enabled-orange?style=flat-square)](#)

Песочница стандартизации рабочих пространств, шаблонов поведения ИИ-агентов (**Google Antigravity**, **OpenCode**, **Claude Code**), динамических правил, скиллов и скриптов автоматизации.

---

## 🚀 Ключевые возможности

### 1. Архитектура динамических правил (`AGENTS.md` < 3.5 КБ)
Каждый проект содержит компактный файл правил со строгим зонированием, исключающим разрастание контекста и галлюцинации:
* **`ZONE: IMMUTABLE`**: Неизменяемое ядро (стек, критические запреты, протокол чтения).
* **`ZONE: INDEX_POINTERS`**: Указатели на вторичные индексы (`docs/navigation-index.md`, `docs/notes-index.md`) и имя домена в долгосрочной памяти.
* **`ZONE: DYNAMIC: NAVIGATION`**: Топ 5–8 главных точек входа без избыточной детализации.
* **`ZONE: DYNAMIC: GOTCHAS`**: До 5 свежих критических подвохов сборки/запуска (ротация FIFO с выгрузкой устаревших в `agentdb`).
* **`ZONE: DYNAMIC: FOCUS`**: Текущий фокус задачи (1–2 строки).

### 2. Протокол экономии контекста (No Greedy Reads)
* Запрет полного чтения файлов более 100 строк.
* Чтение кода строго по диапазонам строк (`offset`/`limit`) либо через AST-граф символов.
* Запрет чтения lock-файлов, сгенерированных бандлов и логов.
* Экономия до **70–85% токенов контекста** за каждую итерацию агента.

### 3. Трехуровневая стратегия поиска (Search Protocol)
1. **Слой 1 (Граф кодовой базы)**: `codebase-memory-mcp` (поиск связей, вызовов и тел функций через tree-sitter).
2. **Слой 2 (Долгосрочная память)**: `agent_memory` / `AgentDB` (поиск по прецедентам и архитектурным решениям).
3. **Слой 3 (Текстовый поиск)**: точечный `grep`/`ripgrep` только при отсутствии данных в первых двух источниках.

### 4. Встроенный форк AIslop (`@antigravity/aislop 0.16.1-agentic`)
Репозиторий включает модифицированный инструмент контроля качества кода ([`tools/aislop`](tools/aislop)), адаптированный под автономных агентов:
* **Детекция неразмеченных моков**: отслеживает переменные `mock*`, `dummy*`, `fake*`, `sample*`, `stub*`, `demo*`, `testData` в производственном коде.
* **Защита от тихих сбоев**: ловит скрытые заглушки `catch { ok = false; }`, `catch { return []; }`, `.catch(() => {})` и `catch {}` (ES2019).
* **Легитимизация техдолга (`AGENT:*`)**: распознает документированный техдолг и дает **100/100 Healthy**, если проставлены маркеры:
  * `// AGENT:MOCK [scope]: reason -> real_service`
  * `// AGENT:STUB [scope]: what is missing`
  * `// AGENT:TEMP [scope]: reason -> next_step`
  * `// AGENT:HARDCODE [scope]: reason -> .env`

---

## 📁 Структура репозитория

```text
agent-templates/
├── README.md                      # Настоящий манифест и руководство
├── .gitignore                     # Глобальные исключения для рабочих пространств
├── .aislopignore                  # Исключения для сканера качества
├── rules/                         # Шаблоны и модули правил для агентов
│   ├── DYNAMIC_AGENTS.template.md # Динамический мастер-шаблон AGENTS.md (< 3.5 КБ)
│   ├── DYNAMIC_GEMINI.template.md # Шаблон под Google Antigravity / Gemini CLI
│   ├── DYNAMIC_CLAUDE.template.md # Шаблон под Claude Code
│   ├── AGENTS.template.md         # Базовый мастер-шаблон
│   └── modules/                   # Составные модули правил
│       ├── code-markers.md        # Стандарт маркировки техдолга (AGENT:*)
│       ├── no-greedy-reads.md     # Протокол запрета жадного чтения
│       ├── search-priority.md     # 3-уровневый поиск
│       ├── terminal-hygiene.md    # Гигиена CLI и сжатие вывода
│       └── yagni-ponytail.md      # Принцип минимализма
├── agents/                        # Профили ролей и системных инструкций
│   ├── architect.md               # Архитектор-минималист
│   ├── refactorer.md              # Рефакторинг и сокращение кода (Ponytail)
│   └── auditor.md                 # Аудит контекста, секретов и качества
├── skills/                        # Скиллы для расширения возможностей агентов
│   ├── token-guard/               # Защита от перерасхода контекста
│   ├── workspace-prep/            # Быстрая подготовка проектов
│   ├── rules-maintainer/          # Самообслуживание и очистка правил
│   └── doc-maintainer/            # Ведение документации, спек и планов
├── workspaces/                    # Каркасы директорий (Scaffolding)
│   ├── minimal-agentic/           # Каркас docs/ (specs, plans, decisions), индексы
│   ├── mcp-server/                # Шаблон TypeScript MCP сервера
│   └── web-fullstack/             # Шаблон веб-приложения
├── scripts/                       # Автоматизация и утилиты
│   ├── init-workspace.ps1         # Полная инициализация workspace, Git Remote и AgentDB
│   ├── register-agentdb-domain.py # Автономная регистрация домена проекта в AgentDB
│   ├── audit-context.ps1          # Сканер контекста, гигиены и лимитов
│   ├── generate-code-map.ps1      # Генерация компактной карты файлов
│   └── hook-pre-invocation.py     # Pre-invocation хук для динамической сборки контекста
├── tools/                         # Встроенные инструменты
│   └── aislop/                    # Форк @antigravity/aislop (0.16.1-agentic) с MCP сервером
└── docs/                          # Методические материалы и спецификации
    ├── project-structure-canon.md # Канон структуры папок и гигиены
    ├── dynamic-rules-spec.md      # Спецификация динамических правил
    ├── token-saving-guide.md      # Руководство по экономии 70-85% токенов
    ├── mcp-ecosystem.md           # Триада MCP (Codebase -> Memory -> Aislop)
    └── specs/                     # Спецификации форка aislop и маркеров
```

---

## 🛠️ Быстрый старт

### 1. Инициализация нового проекта за одну команду
Скрипт автоматически подготовит структуру `docs/`, создаст защитные `.gitignore`/`.dockerignore`, сгенерирует оптимизированный проектный `AGENTS.md` (< 3.5 КБ), зарегистрирует домен проекта в `AgentDB`, инициализирует Git-репозиторий и подключит удаленный репозиторий (remote origin):

```powershell
.\scripts\init-workspace.ps1 `
  -TargetPath "C:\Projects\MyNewProject" `
  -ProjectName "my-new-project" `
  -ProjectStack "Next.js / TypeScript / Tailwind" `
  -RemoteUrl "git@github.com:username/my-new-project.git"
```

### 2. Аудит проекта на соответствие стандартам
Проверка бюджета правил, исключений логов/секретов и целостности документации:

```powershell
.\scripts\audit-context.ps1 -TargetPath "C:\Projects\MyNewProject"
```

### 3. Проверка качества кода через AIslop
Запуск автономного сканирования перед коммитом:

```powershell
aislop scan -d "C:\Projects\MyNewProject"
```

---

## 🔌 Подключение MCP-сервера AISLOP

Форк содержит встроенный MCP-сервер ([`tools/aislop/dist/mcp.js`](tools/aislop/dist/mcp.js)).

### Для Google Antigravity (`~/.gemini/config/mcp_config.json`)
```json
{
  "mcpServers": {
    "aislop": {
      "command": "node",
      "args": [
        "C:/Agent templates/tools/aislop/dist/mcp.js"
      ]
    }
  }
}
```

### Для OpenCode (`~/.config/opencode/opencode.json`)
```json
{
  "mcp": {
    "aislop": {
      "type": "local",
      "command": [
        "node",
        "C:/Agent templates/tools/aislop/dist/mcp.js"
      ],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

---

## 📄 Лицензия & Атрибуция

Проект распространяется под лицензией [MIT](LICENSE).

Компонент `tools/aislop` является форком проекта [scanaislop/aislop](https://github.com/scanaislop/aislop) (автор: Kenny Olawuwo, лицензия MIT), расширенным командой Antigravity для поддержки маркеров техдолга `AGENT:*`, безаргументных блоков `catch` и детекции скрытых моков.
