<!-- ZONE: IMMUTABLE: START -->
# Project Rules: {{PROJECT_NAME}}

Inherits: global user_rules (3-Tier Search, No Greedy Reads, YAGNI, Aislop)

## Project Stack & Constraints
- Stack: {{PROJECT_STACK}}
- Constraints: Strict typing, standard library first, no any.
- Debt Markers: Mark all temporary mocks, stubs, and hardcode with 'AGENT:MOCK', 'AGENT:STUB', 'AGENT:HARDCODE'. Unmarked debt fails 'aislop_aislop_scan'.
<!-- ZONE: IMMUTABLE: END -->

<!-- ZONE: INDEX_POINTERS: START -->
## Deep Routing & Indexes
- Detailed Symbol & File Map: [docs/navigation-index.md](docs/navigation-index.md)
- Operational Notes & Decisions: [docs/notes-index.md](docs/notes-index.md)
- Debt Registry Query: `rg "AGENT:(MOCK|STUB|HARDCODE)"`
- AgentDB Domain: `{{PROJECT_NAME}}` (query via agentdb_agentdb_search with project filter)
<!-- ZONE: INDEX_POINTERS: END -->

<!-- ZONE: DYNAMIC: NAVIGATION: START -->
## Core Entry Points (Top 5-8)
<!-- Примеры ниже — замените на реальные точки входа проекта при инициализации -->
- Entrypoint: src/index.ts
- Configuration: config/
- API Routes: src/api/
- Data Schemas: src/models/
<!-- ZONE: DYNAMIC: NAVIGATION: END -->

<!-- ZONE: DYNAMIC: GOTCHAS: START -->
## Project Gotchas (Max 5, FIFO Rotation)
- [{{INIT_DATE}}] Проект инициализирован. Запуск тестов: {{TESTCMD}}.
<!-- ZONE: DYNAMIC: GOTCHAS: END -->

<!-- ZONE: DYNAMIC: FOCUS: START -->
## Current Focus
- Начальная настройка архитектуры и компонентов проекта.
<!-- ZONE: DYNAMIC: FOCUS: END -->
