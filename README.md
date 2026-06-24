# MCP-прокси сервер для «Управление IT-отделом 8»

## Что это

Прокси-сервер между MCP-клиентами (Claude Desktop, Cursor) и 1С:Предприятие. Транслирует MCP-протокол в JSON-RPC вызовы к HTTP-сервису 1С.

Предназначен для конфигурации [«Управление IT-отделом 8»](https://softonit.ru/catalog/products/it/) — встроенный в неё MCP-сервис предоставляет AI-агентам инструменты для работы с задачами, проектами, базой знаний, файлами и лентой уведомлений.

**Возможности:**
- Два транспорта: stdio (для нативных клиентов) и Streamable HTTP (для веб)
- Проксирование всех MCP-примитивов: Tools, Resources, Prompts
- Опциональная OAuth2 авторизация с per-user креденшилами

## Быстрый старт

### Требования

- **Node.js 22.19+**
- 1С:Предприятие 8.3.24+ с опубликованным HTTP-сервисом

### Установка

```bash
# Установка зависимостей
npm install

# Сборка
npm run build
```

### Выбор режима работы

#### Stdio режим

Для локальных MCP-клиентов (Claude Desktop, Cursor).

Настройки указываются в конфигурации клиента через переменные окружения.

**Минимальная конфигурация клиента:**

```json
{
  "mcpServers": {
    "uit": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/mcp",
      "env": {
        "MCP_ONEC_URL": "http://localhost/base",
        "MCP_ONEC_USERNAME": "admin",
        "MCP_ONEC_PASSWORD": "password"
      }
    }
  }
}
```

#### HTTP режим

Для веб-приложений и множественных клиентов.

Настройки указываются в файле `.env` в корне проекта или через переменные окружения:

```bash
# Скопируйте пример
cp .env.example .env
```

**Минимальный .env:**
```ini
MCP_ONEC_URL=http://localhost/base
MCP_ONEC_USERNAME=admin
MCP_ONEC_PASSWORD=password
```

**Запуск:**
```bash
node dist/index.js http --port 8000
```

**Минимальная конфигурация клиента если запуск через Docker:**

```json
{
  "mcpServers": {
    "uit": {
      "type": "http",
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

### Docker

Запуск в контейнере для изоляции и упрощения развертывания.

#### Первичная установка

```bash
# 1. Клонируем репозиторий
git clone https://github.com/Diversus23/itmcp.git

# 2. Переходим в папку, где находится клонированный itmcp
cd itmcp

# 3. Скопировать конфигурацию
cp .env.docker.example .env

# 4. Отредактировать .env (обязательно: MCP_ONEC_URL, MCP_ONEC_USERNAME, MCP_ONEC_PASSWORD)

# 5. Запустить через docker compose
docker compose build --no-cache
docker compose up -d

# 6. Проверка, что все работает
curl http://localhost:8000/health
```

**Или напрямую через Docker:**

```bash
# Сборка образа
docker build -t 1c-mcp-proxy .

# Запуск с переменными окружения
docker run -d \
  -p 8000:8000 \
  -e MCP_ONEC_URL=http://host.docker.internal/base \
  -e MCP_ONEC_USERNAME=admin \
  -e MCP_ONEC_PASSWORD=password \
  --name mcp-proxy \
  1c-mcp-proxy
```

**Важно про сеть:**

- Если 1С на **том же хосте**: используйте `host.docker.internal` (Mac/Windows) или IP хоста `172.17.0.1` (Linux) вместо `localhost`
- Если 1С на **другом сервере**: указывайте его реальный адрес как обычно

**Логи:**

```bash
docker compose logs -f
```

**Остановка:**

```bash
docker compose down
```

#### Обновление в docker

Когда выходит новая версия необходимо пересобрать образ MCP в docker. Необходимо перейти в папку, куда клонировали репозиторий `itmcp`.

```bash
# 1. Получаем изменения новой версии
git pull

# 2. Останавливаем контейер
docker compose down

# 3. Пересобираем образ
docker compose build --no-cache

# 4. Запускаем новый образ (обновленный)
docker compose up -d
```

## Режимы работы

### Stdio режим

- Общение через stdin/stdout
- Используется локальными MCP-клиентами
- Логи идут в stderr
- OAuth2 не поддерживается (при `MCP_AUTH_MODE=oauth2` запуск завершится ошибкой)

### HTTP режим

**Endpoints:**

- `/mcp` - Streamable HTTP транспорт
- `/health` - проверка состояния
- `/info` - информация о сервере
- `/` - список endpoints

**Проверка работы:**
```bash
curl http://localhost:8000/health
```

## Режимы авторизации

### Без OAuth2 (по умолчанию)

```bash
MCP_AUTH_MODE=none  # по умолчанию
```

**Поведение:**
- Все обращения к 1С выполняются от одного пользователя
- Креденшилы задаются в конфигурации: `MCP_ONEC_USERNAME` и `MCP_ONEC_PASSWORD`
- Используется Basic Auth для всех запросов к 1С

### С OAuth2

```bash
MCP_AUTH_MODE=oauth2
MCP_PUBLIC_URL=http://your-server:8000
```

**Поведение:**
- OAuth2 доступен только в HTTP режиме (в stdio запуск завершится ошибкой)
- Каждый клиент авторизуется своими креденшилами 1С
- Креденшилы передаются через OAuth2 flow
- `MCP_ONEC_USERNAME` и `MCP_ONEC_PASSWORD` не используются (если заданы, будут проигнорированы)

**Поддерживаемые OAuth2 flows:**
- **Password Grant** - передача username/password напрямую
- **Authorization Code + PKCE** - авторизация через HTML-форму
- **Dynamic Client Registration** - автоматическая регистрация клиентов

**Дополнительные endpoints (для OAuth2):**
- `/.well-known/oauth-protected-resource` - Protected Resource Metadata
- `/.well-known/oauth-authorization-server` - Authorization Server Metadata
- `/register` - регистрация клиентов
- `/authorize` - HTML форма авторизации
- `/token` - получение/обновление токенов

## Конфигурация

Все настройки задаются через переменные окружения с префиксом `MCP_` или через CLI аргументы.

### Подключение к 1С

| Переменная | Описание | По умолчанию | Обязательная |
|------------|----------|--------------|--------------|
| `MCP_ONEC_URL` | URL базы 1С | - | Всегда |
| `MCP_ONEC_USERNAME` | Имя пользователя | - | При `AUTH_MODE=none` |
| `MCP_ONEC_PASSWORD` | Пароль | - | При `AUTH_MODE=none` |
| `MCP_ONEC_SERVICE_ROOT` | Корень HTTP-сервиса | `mcp` | Нет |

### HTTP-сервер

| Переменная | Описание | По умолчанию | Обязательная |
|------------|----------|--------------|--------------|
| `MCP_HOST` | Хост для прослушивания | `127.0.0.1` | Нет |
| `MCP_PORT` | Порт | `8000` | Нет |
| `MCP_CORS_ORIGINS` | CORS origins (JSON array) | `["*"]` | Нет |

### MCP

| Переменная | Описание | По умолчанию | Обязательная |
|------------|----------|--------------|--------------|
| `MCP_SERVER_NAME` | Имя сервера | `Управление IT-отделом 8 MCP` | Нет |
| `MCP_SERVER_VERSION` | Версия | `1.0.0` | Нет |
| `MCP_LOG_LEVEL` | Уровень логирования | `INFO` | Нет |

Допустимые уровни: `DEBUG`, `INFO`, `WARNING`, `ERROR`

### OAuth2

| Переменная | Описание | По умолчанию | Обязательная |
|------------|----------|--------------|--------------|
| `MCP_AUTH_MODE` | Режим: `none` или `oauth2` | `none` | Нет |
| `MCP_PUBLIC_URL` | Публичный URL прокси | (определяется из запроса) | При `AUTH_MODE=oauth2` |
| `MCP_OAUTH2_CODE_TTL` | TTL authorization code (сек) | `120` | Нет |
| `MCP_OAUTH2_ACCESS_TTL` | TTL access token (сек) | `3600` | Нет |
| `MCP_OAUTH2_REFRESH_TTL` | TTL refresh token (сек) | `1209600` | Нет |
| `MCP_OAUTH2_STORE_PATH` | Путь к JSON-снапшоту токенов | (только в памяти) | Нет |
| `MCP_OAUTH2_REFRESH_GRACE_MS` | Окно идемпотентности refresh-rotation (мс) | `60000` | Нет |

**Персистентность токенов.** При указанном `MCP_OAUTH2_STORE_PATH` access- и
refresh-токены сериализуются в JSON-файл (атомарная запись через временный
файл) каждые 30 секунд и при graceful shutdown. После рестарта прокси
загружает снапшот, отбрасывая истекшие записи. Это устраняет повторные
логины пользователей при перезапуске контейнера / краше процесса.

> **⚠️ Безопасность снапшота.** Файл содержит логины и пароли пользователей
> 1С в открытом виде (Basic Auth требуется для каждого запроса к 1С).
> Файл создаётся с правами `0o600` (только владелец) на POSIX-системах;
> на Windows mode игнорируется — обеспечьте ограниченные NTFS ACL на
> каталог. Не храните снапшот в общем томе, не коммитьте в репозиторий
> (`./data` уже игнорируется через `.gitignore`).

**Grace-window для refresh-rotation.** При повторном использовании одного и
того же `refresh_token` в течение `MCP_OAUTH2_REFRESH_GRACE_MS` сервер
возвращает ранее выпущенную пару токенов (идемпотентно) — защита от race
condition при параллельных refresh-запросах клиента. По истечении окна
повторное использование считается атакой и приводит к отзыву всей цепочки
токенов этой сессии (RFC 6819 §5.2.2.3).

### CLI аргументы

Переопределяют переменные окружения:

```bash
node dist/index.js http \
  --onec-url http://server/base \
  --onec-username admin \
  --onec-password secret \
  --auth-mode oauth2 \
  --public-url http://proxy:8000 \
  --port 8000 \
  --log-level DEBUG
```

Полный список аргументов:
```bash
node dist/index.js --help
```

## Архитектура

### Общая схема

```
+------------------+
|   MCP Client     |  (Claude Desktop, Cursor)
|  (stdio/HTTP)    |
+--------+---------+
         | MCP Protocol
         v
+--------------------+
|  Node.js Proxy     |
|  - mcp-proxy       |  Проксирование MCP -> JSON-RPC
|  - http-server     |  Express + Streamable HTTP + OAuth2
|  - stdio-server    |  Stdio транспорт
|  - onec-client     |  HTTP-клиент для 1С
+--------+-----------+
         | JSON-RPC over HTTP
         | Basic Auth (username:password)
         v
+--------------------+
|  1C HTTP Service   |  /hs/mcp/rpc
|  МСP-подсистема    |  39 tools, resources, prompts
+--------------------+
```

### Модули

- **`index.ts`** - точка входа
- **`main.ts`** - CLI парсинг и запуск
- **`config.ts`** - конфигурация через Zod
- **`mcp-proxy.ts`** - ядро MCP-сервера (проксирование)
- **`onec-client.ts`** - HTTP-клиент для 1С
- **`http-server.ts`** - Express + Streamable HTTP + OAuth2
- **`stdio-server.ts`** - stdio транспорт
- **`auth/oauth2.ts`** - OAuth2 авторизация (Store + Service)
- **`logger.ts`** - логирование в stderr

### Проксирование MCP-примитивов

Все MCP-запросы транслируются в JSON-RPC к 1С:

**Tools (инструменты):**
- `tools/list` -> список доступных инструментов
- `tools/call` -> вызов инструмента с аргументами

**Resources (ресурсы):**
- `resources/list` -> список доступных ресурсов
- `resources/read` -> чтение содержимого ресурса

**Prompts (промпты):**
- `prompts/list` -> список доступных промптов
- `prompts/get` -> получение промпта с параметрами

## Интеграция с 1С

Прокси ожидает HTTP-сервис в 1С по адресу:
```
{MCP_ONEC_URL}/hs/{MCP_ONEC_SERVICE_ROOT}/
```

Например: `http://localhost/base/hs/mcp/`

### Endpoints 1С

1. **`GET /health`**
   - Проверка доступности сервиса
   - Ответ: `{"status": "ok"}`
   - Используется для валидации креденшилов в OAuth2

2. **`POST /rpc`**
   - JSON-RPC endpoint для всех MCP-операций
   - Content-Type: `application/json`
   - Basic Auth: `username:password`

### Формат JSON-RPC запроса

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### Формат JSON-RPC ответа

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "get_metadata",
        "description": "Получить метаданные объекта",
        "inputSchema": {}
      }
    ]
  }
}
```

## Разработка

```bash
# Установка зависимостей
npm install

# Сборка
npm run build

# Сборка в watch-режиме
npm run dev

# Запуск stdio
npm start

# Запуск HTTP
npm run start:http
```

---

**MIT License**
