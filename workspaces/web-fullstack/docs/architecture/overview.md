# Fullstack Web Architecture

## Стек технологий
- **Frontend**: Next.js / React (App Router), Tailwind CSS.
- **Backend**: Next.js API Routes или FastAPI / Express.
- **Database**: PostgreSQL / SQLite с Prisma или Drizzle ORM.

## Структура монорепозитория / папок
```
/
├── apps/ (или src/)
│   ├── web/                # Пользовательский интерфейс и страницы
│   └── api/                # Серверные эндпоинты и бизнес-логика
├── packages/               # Общие пакеты (типы, валидаторы z-schemas)
├── docs/                   # Архитектура, API спецификации, схемы БД
└── scripts/                # Скрипты миграций и сборки
```

## Правила работы для агентов
1. Не генерировать моки данных прямо в компонентах UI — использовать единый слой API клиентов.
2. Проверять контракты данных через Zod / Pydantic схемы.
3. Перед коммитом запускать `npx aislop scan` и локальный build.
