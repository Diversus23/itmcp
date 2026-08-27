# Changelog

Все значимые изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [семантическому версионированию](https://semver.org/lang/ru/).

## [1.2.1] - 2026-08-27

### Security

- Обновлён `undici` 8.5.0 → 8.10.0: закрыты уязвимости GHSA-4cwx-7wf7-3272
  (high — раскрытие данных между пользователями через разделяемый кэш),
  GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-8xcm-r25x-g524,
  GHSA-v3r7-h72x-cjcm (CRLF-инъекции, обход ограничений кэша, инъекция
  атрибутов cookie).

### Changed

- Обновлён `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 (исправления SSE
  keep-alive в Streamable HTTP-транспорте и валидации Content-Type).
- Обновлены dev-зависимости: `eslint` 10.9.1, `typescript-eslint` 8.68.0,
  `prettier` 3.9.6, `vitest`/`@vitest/coverage-v8` 4.1.11,
  `lint-staged` 17.4.1, `@types/node` 26.4.0.
- Обновлены GitHub Actions: `actions/checkout` v7, `actions/setup-node` v7,
  `docker/metadata-action` v6.

## [1.2.0] - 2026-07-06

### Added

- Тулинг качества кода: **ESLint 10** (flat config) + `typescript-eslint`
  (type-aware правила), **Prettier**, `.editorconfig`, `.gitattributes`
  (единый LF во всём репозитории).
- **Vitest**: тестовый набор для критичных модулей — `config` (валидация Zod),
  `auth/oauth2` (PKCE, ротация refresh-токенов, grace-window, отзыв семьи,
  персистентность снапшота) и `onec-client` (JSON-RPC, Basic Auth, health).
  Покрытие через `@vitest/coverage-v8`.
- **Husky** pre-commit хук с `lint-staged` (eslint --fix + prettier на
  staged-файлах).
- **GitHub Actions**:
  - `ci.yml` — format/lint/typecheck/build/test на матрице Node 22 и 24
    + сборка Docker-образа + информационный `npm audit`.
  - `codeql.yml` — статический анализ безопасности (security-and-quality).
  - `release.yml` — сборка и публикация Docker-образа в GHCR по тегу `vX.Y.Z`.
  - `dependabot.yml` — еженедельные обновления npm, GitHub Actions и base-образа.
- npm-скрипты: `typecheck`, `lint`, `lint:fix`, `format`, `format:check`,
  `test`, `test:watch`, `test:coverage`, `check`.
- Документация (`README.md`): раздел о подключении Claude Desktop к
  HTTP-серверу через мост `mcp-remote` — Claude Desktop не поддерживает поле
  `url` в `claude_desktop_config.json`, только stdio-запуск через `command`.
- Документация (`README.md`): раздел «Документация» и контекстные ссылки на
  онлайн-руководства docs.softonit.ru (развёртывание MCP-сервера и подключение
  AI-клиентов) для решения «Управление IT-отделом 8».

### Changed

- Ужесточён `tsconfig.json`: `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `noImplicitReturns`.
- Обработчики сигналов (`SIGINT`/`SIGTERM`) и `server.onclose` переведены на
  явный `void` для промисов — устранены floating/misused promises.
- Логирование ошибок типа `unknown` в шаблонных строках теперь идёт через
  `formatError`/`String` вместо неявной интерполяции.
- `Dockerfile`: установка зависимостей с `--ignore-scripts` (lifecycle-скрипты,
  включая `prepare`/husky, в образе не нужны).
- `Dockerfile`: базовый образ обновлён `node:22-slim` → `node:26-slim`.
- Обновлены dev-зависимости (Dependabot): `eslint` 10.6, `prettier` 3.9
  (переформатирован `src/auth/oauth2.ts`), `typescript-eslint` 8.62.1,
  `@types/node` 26.
- Обновлены версии GitHub Actions (Dependabot): `actions/setup-node` v6,
  `github/codeql-action` v4, `docker/build-push-action` v7,
  `docker/setup-buildx-action` v4, `docker/login-action` v4.

### Fixed

- `OneCClient.downloadFile`: безопасное извлечение `filename` из
  `Content-Disposition` при включённом `noUncheckedIndexedAccess`.

## [1.1.4] - 2026-06-24

### Added

- MCP-прокси сервер для конфигурации «Управление IT-отделом 8»:
  транспорты stdio и Streamable HTTP, проксирование Tools/Resources/Prompts,
  опциональная OAuth2-авторизация с per-user креденшилами и персистентностью
  токенов.
