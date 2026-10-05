# Antigravity / Gemini Agent Protocol

## Приоритет поиска и навигации
1. **Первый приоритет**: `codebase-memory-mcp` — сначала точное имя проекта (`codebase-memory-mcp_list_projects`) и свежесть индекса (`codebase-memory-mcp_index_status`), затем поиск связей, классов, функций и компонентов по графу.
2. **Второй приоритет**: `agentdb` — проверка решений и знаний в `agentdb_agentdb_search` (по базам `agent_memory.db` и `pathfinder.db`).
3. **Третий приоритет**: прямой поиск по файлам (`grep` / `glob`, чтение через `read` с `offset`/`limit`).

## Контроль контекста и токенов
- Никакого чтения файлов целиком без строгой необходимости (`offset`/`limit` обязательны при размере > 100 строк).
- Не читай бинарные файлы, lock-файлы (`package-lock.json`, `poetry.lock`), папки сборки и кэши.
- Сворачивай длинные листинги: используй узкие glob-паттерны вместо широких листингов директорий.

## Стандарты разработки
- **YAGNI (Ponytail)**: Минималистичный подход без лишней вариативности и оверинжиниринга.
- **Чистота кода (Aislop)**: Запуск `aislop_aislop_scan` перед коммитами (fallback: `node ~/.agent-templates/tools/aislop/dist/cli.js scan`). Порядок: сначала scan, потом `aislop_aislop_fix`; при `MCP error -32001` — повторить на меньшем `path` или из терминала.
- **Фиксация контекста**: Важные архитектурные решения сохраняй в `agentdb` через `agentdb_agentdb_store`.
