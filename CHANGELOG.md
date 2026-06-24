# Changelog

Все значимые изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [семантическому версионированию](https://semver.org/lang/ru/).

## [Unreleased]

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

### Changed

- Ужесточён `tsconfig.json`: `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `noImplicitReturns`.
- Обработчики сигналов (`SIGINT`/`SIGTERM`) и `server.onclose` переведены на
  явный `void` для промисов — устранены floating/misused promises.
- Логирование ошибок типа `unknown` в шаблонных строках теперь идёт через
  `formatError`/`String` вместо неявной интерполяции.
- `Dockerfile`: установка зависимостей с `--ignore-scripts` (lifecycle-скрипты,
  включая `prepare`/husky, в образе не нужны).

### Fixed

- `OneCClient.downloadFile`: безопасное извлечение `filename` из
  `Content-Disposition` при включённом `noUncheckedIndexedAccess`.

## [1.1.4] - 2026-06-24

### Added

- MCP-прокси сервер для конфигурации «Управление IT-отделом 8»:
  транспорты stdio и Streamable HTTP, проксирование Tools/Resources/Prompts,
  опциональная OAuth2-авторизация с per-user креденшилами и персистентностью
  токенов.
