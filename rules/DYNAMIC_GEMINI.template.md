<!-- ZONE: IMMUTABLE: START -->
# Project Rules: {{PROJECT_NAME}} (Antigravity / Gemini)

Inherits: global user_rules (3-Tier Search, No Greedy Reads, YAGNI, Aislop)

## Project Stack & Constraints
- Stack: {{PROJECT_STACK}}
- Constraints: Strict typing, standard library first, line-range reads on files > 100 lines.
- Debt Markers: Mark all temporary mocks, stubs, and hardcode with 'AGENT:MOCK', 'AGENT:STUB', 'AGENT:HARDCODE'. Unmarked debt fails 'aislop scan'.
<!-- ZONE: IMMUTABLE: END -->

<!-- ZONE: INDEX_POINTERS: START -->
## Deep Routing & Indexes
- Detailed Symbol & File Map: [docs/navigation-index.md](docs/navigation-index.md)
- Operational Notes & Decisions: [docs/notes-index.md](docs/notes-index.md)
- Debt Registry Query: `rg "AGENT:(MOCK|STUB|HARDCODE)"`
- AgentDB Domain: `{{PROJECT_NAME}}` (query via search_memory / agentdb_search)
<!-- ZONE: INDEX_POINTERS: END -->

<!-- ZONE: DYNAMIC: NAVIGATION: START -->
## Core Entry Points (Top 5-8)
- Entrypoint: src/index.ts
- Configuration: config/
- API Routes: src/api/
- Data Schemas: src/models/
<!-- ZONE: DYNAMIC: NAVIGATION: END -->

<!-- ZONE: DYNAMIC: GOTCHAS: START -->
## Project Gotchas (Max 5, FIFO Rotation)
- [{{INIT_DATE}}] Проект инициализирован. Запуск тестов через 'npm test' / 'pytest'.
<!-- ZONE: DYNAMIC: GOTCHAS: END -->

<!-- ZONE: DYNAMIC: FOCUS: START -->
## Current Focus
- Начальная настройка архитектуры и компонентов проекта.
<!-- ZONE: DYNAMIC: FOCUS: END -->
