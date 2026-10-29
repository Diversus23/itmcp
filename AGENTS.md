# itmcp

MCP-прокси между AI-клиентами и HTTP-сервисом 1С:Предприятие (решение «Управление IT-отделом 8»). TypeScript, Node, Docker. Общение и комментарии в коде — на русском.

Этот файл — единый источник инструкций для всех AI-агентов (Claude Code, Codex, Cursor и др.). Адаптеры вроде `CLAUDE.md` только отсылают сюда и не дублируют текст.

## Структура

| Путь | Назначение |
| --- | --- |
| `src/index.ts`, `src/main.ts` | точка входа, CLI (`http` / `stdio`) |
| `src/config.ts` | чтение настроек из переменных окружения |
| `src/http-server.ts` | Streamable HTTP, OAuth2-эндпоинты, страница входа |
| `src/stdio-server.ts` | stdio-режим |
| `src/mcp-proxy.ts` | проксирование Tools / Resources / Prompts в 1С |
| `src/onec-client.ts` | HTTP-клиент 1С, типизированные ошибки с подсказками |
| `src/auth/` | OAuth2, ограничение частоты попыток входа |
| `tests/` | vitest; мок 1С поднимается на эфемерном порту |
| `.docs/` | документация для сопровождающих |

## Команды

```bash
npm run check   # format:check + lint + typecheck + test — запускать перед коммитом
npm test        # только тесты
npm run build   # tsc в dist/
```

В lint есть около 30 старых предупреждений `no-unsafe-*` — они не блокируют. Новый код не должен добавлять ни ошибок, ни предупреждений.

## Правила разработки

- Сначала тест, который падает, потом код. Новые тесты для HTTP-слоя — в `tests/http-session.test.ts`, для клиента 1С — в `tests/onec-client.test.ts`.
- Форматирование — prettier (`npx prettier --write`), переводы строк LF.
- Ошибки обращения к 1С — это `OneCRequestError` (`OneCHttpError`, `OneCConnectionError`): `message` — короткая сводка без внутренних адресов и путей, `hint` — вероятная причина и что проверить, `detail` — полные подробности только для лога. Пользователю (MCP-клиенту, странице входа) показывать `formatOneCError(e)`, а не стек и не `detail`.
- Отказ в авторизации (401/403) определять по `statusCode`, а не по тексту сообщения.
- Секреты (`.env`, пароли, токены, `data/`) не коммитить и не выводить в консоль и чат.

## Коммиты и релизы

- Сообщения коммитов — Conventional Commits на русском: `fix(oauth2): …`, `feat(auth): …`, `docs: …`.
- Релиз — отдельный коммит `chore(release): версия X.Y.Z`: меняются `version` в `package.json` и `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`) и добавляется раздел в `CHANGELOG.md` (формат Keep a Changelog, разделы Added / Changed / Fixed / Security). Тег `vX.Y.Z` запускает публикацию образа в GHCR.
- Коммит, push и тег — только по явной просьбе пользователя.

## Production

Прокси работает на боевой ВМ в Docker. Доступ, обновление, откат и диагностика описаны в [.docs/deploy-production.md](.docs/deploy-production.md). Параметры доступа лежат в локальном `.env`: `MCP_DEPLOY_SERVER`, `MCP_DEPLOY_USERNAME`, `MCP_DEPLOY_PASSWORD`, `MCP_DEPLOY_DIR`.

- Чтение логов и состояния на ВМ можно выполнять самостоятельно.
- `git pull`, пересборку и перезапуск контейнера — только после явного согласия пользователя.
- Пароль не выводить в консоль и чат; в выводе его маскировать.
