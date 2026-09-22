# Спецификация: Модификация AIslop для детекции и валидации маркеров техдолга агентов (AGENT:*)

- **Проект**: `aislop` (Antigravity Agentic Fork)
- **Upstream**: [scanaislop/aislop](https://github.com/scanaislop/aislop) (MIT License)
- **Локальный исходник форка**: `C:\Agent templates\tools\aislop`
- **Статус**: Действующая спецификация

---

## 1. Проблематика и цели

При автономной разработке ИИ-агенты (Antigravity, OpenCode, Claude Code) генерируют код итеративно, оставляя:
1. **Моки** (статические списки пользователей, фиктивные JSON-ответы).
2. **Заглушки** (пустые функции `return null`, методы с `throw NotImplemented`).
3. **Хардкод** (тестовые URL `http://localhost`, токены, порты).

**Проблема**: В 15–20% случаев модель «забывает» задокументировать оставленную заглушку в комментариях. Обычные `TODO` теряются в коде, а поиск по всей кодовой базе сжигает тысячи токенов.

**Цель модификации `aislop`**:
Сделать `aislop` (который уже вызывается перед коммитами по глобальному правилу) детерминированным валидатором маркеров:
- Признавать маркеры `AGENT:*` как официальный задокументированный техдолг (без снижения рейтинга репозитория).
- Блокировать «голые» `TODO`/`FIXME` и требовать перевода в формат `AGENT:STUB` / `AGENT:MOCK`.
- Выявлять очевидные неразмеченные моки (`mockUsers`, `dummyData`) и локальный хардкод (`http://localhost`) в рабочих файлах, выводя подсказку с точным форматом тега.

---

## 2. Стандарт и таксономия маркеров агента

Единый кросс-языковой формат комментария:
```text
// AGENT:<ТИП> [<ОБЛАСТЬ>]: <ОПИСАНИЕ> [-> РЕШЕНИЕ]
# AGENT:<ТИП> [<ОБЛАСТЬ>]: <ОПИСАНИЕ> [-> РЕШЕНИЕ]
-- AGENT:<ТИП> [<ОБЛАСТЬ>]: <ОПИСАНИЕ> [-> РЕШЕНИЕ]
```

### Категории:

| Категория | Назначение | Пример |
|---|---|---|
| **`AGENT:MOCK`** | Моки данных, статические массивы вместо API | `// AGENT:MOCK [users]: Временный список пользователей -> подключить UsersService.findAll()` |
| **`AGENT:STUB`** | Заглушки методов, пустые обработчики, NotImplemented | `# AGENT:STUB [auth]: Валидация JWT не реализована -> добавить проверку через jose` |
| **`AGENT:HARDCODE`** | Зашитые адреса, порты, тестовые ID, временные ключи | `// AGENT:HARDCODE [api]: Тестовый адрес http://localhost:8080 -> вынести в .env API_BASE_URL` |
| **`AGENT:TEMP`** | Временные обходные пути (workarounds), костыли отладки | `// AGENT:TEMP [cache]: Кэш отключен на время отладки сессий` |

---

## 3. Модификация движка `aislop` (Форк)

Модификации вносятся в модуль `src/engines/ai-slop/dead-patterns.ts`:

### А. Легитимизация трекеров техдолга
В регулярное выражение отслеживаемого долга `TODO_TRACKING_RE` добавляется белый список маркеров:
```typescript
export const AGENT_MARKER_RE = /\bAGENT:(?:MOCK|STUB|HARDCODE|TEMP)\b/i;
const TODO_TRACKING_RE =
    /https?:\/\/|#\d+|\bgh-\d+\b|\b[A-Z][A-Z0-9]+-\d+\b|\b(?:issue|ticket|jira)\b|\bAGENT:(?:MOCK|STUB|HARDCODE|TEMP)\b/i;
```
**Результат**: Если агент поставил `// AGENT:MOCK [...]`, комментарий не считается «брошенным TODO» и проект получает 100/100 Healthy.

### Б. Контекстная подсказка при обнаружении «голых» TODO
Если обнаружен комментарий `TODO`, `FIXME`, `HACK`, `STUB`, `TEMP` без трекера:
- Сообщение диагностики модифицируется:
  `"Unresolved TODO/stub without agent tracking. Mark with '// AGENT:STUB [scope]: ...' or '// AGENT:MOCK [scope]: ...' or resolve it."`
- Агент в ответе терминала видит конкретный шаблон тега и мгновенно исправляет строку.

### В. Детекция неразмеченных моков и локального хардкода
Для файлов не-тестового назначения (исключая `*.test.*`, `*.spec.*`, `tests/`):
1. **Неразмеченные мок-переменные**:
   Объявления вида `(?:const|let|var)\s+(?:mock|dummy|fake)[A-Z]\w*` или `\w*(?:Mock|Dummy|Fake)\b\s*=` без предшествующего `AGENT:MOCK`.
   - Диагностика: `"Unmarked mock data in non-test code. Mark with '// AGENT:MOCK [scope]: reason' or replace with real service call."`
2. **Локальный хардкод URL**:
   Строки с `https?://(?:localhost|127\.0\.0\.1)(?::\d+)?` без предшествующего `AGENT:HARDCODE`.
   - Диагностика: `"Hardcoded localhost URL. Move to .env or mark with '// AGENT:HARDCODE [scope]: reason'."`

---

## 4. Что прописывается в правилах проектов (`AGENTS.md`)

В динамический шаблон правил (`rules/DYNAMIC_AGENTS.template.md`, `DYNAMIC_GEMINI.template.md`, `DYNAMIC_CLAUDE.template.md`) в блок `ZONE: IMMUTABLE` добавляется компактное требование (всего 2 строки):

```markdown
## Code Quality & Technical Debt Tracking
- Clean Code Gate: 'npx aislop scan' before commits (target: 100/100 Healthy).
- Debt Tagging: Mark temporary stubs, mocks, and hardcoded values with 'AGENT:STUB', 'AGENT:MOCK', or 'AGENT:HARDCODE'. Unmarked stubs will fail the quality gate.
```

В документацию выносится ссылка на реестр долга:
- `docs/notes-index.md`: секция поиска долгов через быстрый запрос `rg "AGENT:"`.

---

## 5. План развертывания и верификации

1. **Маркировка форка**: В `tools/aislop/README.md` и `package.json` указать авторство форка, ссылку на оригинальный репозиторий `scanaislop/aislop` и описание расширения.
2. **Реализация в TypeScript**: Применить изменения в `tools/aislop/src/engines/ai-slop/dead-patterns.ts`.
3. **Сборка форка**: Собрать проект через `pnpm build` / `npm run build`.
4. **Применение к глобальному инструменту**: Скомпилированные файлы обновить в глобальном пакете `aislop` для моментальной работы в системе.
5. **Тестирование**:
   - Тест 1: Файл с `// TODO: fix later` -> предупреждение с рекомендацией `AGENT:STUB`.
   - Тест 2: Файл с `// AGENT:MOCK [users]: test list` -> 100/100 Healthy.
   - Тест 3: Файл с `const mockUsers = [...]` без тега -> предупреждение о неразмеченном моке.
   - Тест 4: Файл с `const mockUsers = [...]` с тегом `// AGENT:MOCK` -> 100/100 Healthy.
