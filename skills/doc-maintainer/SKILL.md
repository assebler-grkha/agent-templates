---
name: doc-maintainer
description: Управление проектной документацией, спецификациями, планами и файлами гигиены (.env.example, .gitignore, .dockerignore) без раздувания контекста.
---

# Doc Maintainer (Ведение проектной документации)

Скилл активируется агентом при проектировании новых экранов, создании API эндпоинтов, принятии архитектурных решений, добавлении переменных окружения или завершении спринтов.

## Триггеры активации
- Создание новой фичи, экрана или API сервиса.
- Добавление новой переменной в код (`process.env.VAR` / `os.getenv("VAR")`).
- Завершение всех задач в активном плане спринта.
- Необходимость временного тестового скрипта (отправляется в `scratch/`).

## Протокол действий агента

### 1. Создание спецификаций и планов
- **UI спецификация**: создается в `docs/specs/ui/{NN}_{screen}_spec.md` по шаблону `docs/templates/ui-spec-template.md`.
- **API спецификация**: создается в `docs/specs/api/{NN}_{service}_spec.md` по шаблону `docs/templates/api-spec-template.md`.
- **Архитектурное решение**: создается в `docs/decisions/{NNNN}_{decision}.md` по шаблону ADR.
- **План фазы**: создается в `docs/plans/{phase}_plan.md`. В папке `docs/plans/` не должно быть более 2 активных планов!

### 2. Обязательная регистрация в индексах
- Каждая новая спека немедленно регистрируется в строке таблицы [`docs/navigation-index.md`](file:///C:/Agent%20templates/workspaces/minimal-agentic/docs/navigation-index.md).
- Каждое решение (ADR) регистрируется ссылкой в [`docs/notes-index.md`](file:///C:/Agent%20templates/workspaces/minimal-agentic/docs/notes-index.md).
- **В `AGENTS.md` ничего не дописывается** — он сохраняет бюджет <= 3.5 КБ!

### 3. Синхронизация `.env.example`
- При добавлении в коде нового обращения к окружению проверить, есть ли переменная в `.env.example`.
- Если нет — добавить строку с описанием назначения:
  `# [Required/Optional] Краткое описание назначения`
  `MY_NEW_VAR="default_or_empty"`

### 4. Жизненный цикл и архивация (Definition of Done)
- Когда все пункты в `docs/plans/{phase}_plan.md` отмечены `[x]`:
  1. Изменить статус в шапке на `Status: Completed`.
  2. Переместить файл в `docs/archive/{phase}_plan.md`.
  3. Сохранить краткий итог вехи в `AgentDB` (`store_memory(key="{project}_{phase}_completed", project="{project_name}")`).
  4. Обновить поле `Current Focus` в `AGENTS.md` на следующую задачу.

### 5. Использование `scratch/`
- Любые проверочные скрипты (`test_api.py`, `curl_test.sh`, `migrate_helper.js`) создавать **только** в папке `scratch/`.
- Никогда не оставлять временные скрипты в корне или внутри `src/`.
