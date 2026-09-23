# API Spec: {{SERVICE_NAME}}

- **Status**: Draft | Active | Implemented
- **Base Route**: `/api/v1/{{BASE_PATH}}`
- **Auth Required**: Bearer JWT / API Key / Public
- **Rate Limit**: {{RATE_LIMIT_RPS}} req/sec

---

## 1. Назначение сервиса
Краткое описание функционала и поддерживаемых бизнес-операций.

## 2. Эндпоинты

### `GET /api/v1/{{BASE_PATH}}`
Получение списка записей с пагинацией и фильтрами.

**Параметры запроса (Query Params)**:
- `page` (int, default 1): Номер страницы.
- `limit` (int, default 20, max 100): Количество записей.
- `status` (string, optional): Фильтр по статусу.

**Успешный ответ (200 OK)**:
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "string",
      "createdAt": "2026-09-22T00:00:00Z"
    }
  ],
  "total": 100,
  "page": 1,
  "totalPages": 5
}
```

### `POST /api/v1/{{BASE_PATH}}`
Создание новой сущности.

**Тело запроса (JSON Schema / Zod)**:
```json
{
  "name": "string",
  "category": "string"
}
```

**Ответы**:
- `201 Created`: Сущность успешно создана.
- `400 Bad Request`: Ошибка валидации полей (возвращает список ошибок Zod).
- `401 Unauthorized`: Не передан токен авторизации.

## 3. Обработка ошибок
Все ошибки возвращаются в едином формате:
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Field 'name' is required"
  }
}
```
