## Протокол холодного старта (Hook-driven Auto-Init)

Инициализация выполняется автоматически — хуком PreInvocation (`hook-pre-invocation.py`) в Antigravity и плагином (`auto-init.ts`) в OpenCode. Агент её вручную НЕ запускает.

### Что цепочка делает без участия агента
1. Проверяет наличие `AGENTS.md` (или `GEMINI.md`) в корне открытого каталога.
2. Если правил нет и это первое обращение — запускает `scripts/init-workspace.ps1` (Windows) или `scripts/init-workspace.sh` (Linux/macOS): структура `docs/` и `scratch/`, файлы гигиены, `README.md`, `AGENTS.md` из шаблона, регистрация домена в AgentDB (`agentdb_agentdb_store(doc_id="{project}_init_meta", ...)`), `git init` и первый коммит.
3. Повторные срабатывания подавлены: backoff 24 ч при неуспехе, кэш при успехе.

### Обязанности агента
1. НЕ запускать `init-workspace` вручную — сначала проверить наличие `AGENTS.md`.
2. Если remote `origin` отсутствует — запросить URL у пользователя и только после ответа выполнить `git remote add origin <url>` и `git push -u origin main`. Push без полученного URL запрещён.
3. После инициализации — немедленно к задаче пользователя.
