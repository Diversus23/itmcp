/**
 * Основной файл запуска MCP-прокси сервера.
 */

import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { getConfig, PACKAGE_VERSION } from "./config.js";
import { setLogLevel, createLogger } from "./logger.js";
import { runHttpServer } from "./http-server.js";
import { runStdioServer } from "./stdio-server.js";

const logger = createLogger("main");

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name("1c-mcp-proxy")
    .description("MCP-прокси сервер для взаимодействия с 1С")
    .version(PACKAGE_VERSION)
    .option("--env-file <path>", "Путь к .env файлу с конфигурацией")
    .option("--onec-url <url>", "URL базы 1С")
    .option("--onec-username <username>", "Имя пользователя 1С")
    .option("--onec-password <password>", "Пароль пользователя 1С")
    .option("--onec-service-root <root>", "Корневой URL HTTP-сервиса в 1С")
    .option("--host <host>", "Хост для HTTP-сервера")
    .option("--port <port>", "Порт для HTTP-сервера")
    .option("--log-level <level>", "Уровень логирования", /^(DEBUG|INFO|WARNING|ERROR)$/i)
    .option("--auth-mode <mode>", "Режим авторизации: none или oauth2")
    .option("--public-url <url>", "Публичный URL прокси для OAuth2")
    .argument("[mode]", "Режим работы: stdio или http", "stdio");

  program.parse();

  const opts = program.opts();
  const mode = program.args[0] ?? "stdio";

  // Загружаем .env
  // quiet: true — dotenv 17+ по умолчанию пишет лог в stdout, что ломает stdio-режим MCP
  if (opts.envFile) {
    loadDotenv({ path: opts.envFile, quiet: true });
  } else {
    loadDotenv({ quiet: true });
  }

  // CLI аргументы переопределяют env vars
  if (opts.onecUrl) process.env.MCP_ONEC_URL = opts.onecUrl;
  if (opts.onecUsername) process.env.MCP_ONEC_USERNAME = opts.onecUsername;
  if (opts.onecPassword) process.env.MCP_ONEC_PASSWORD = opts.onecPassword;
  if (opts.onecServiceRoot) process.env.MCP_ONEC_SERVICE_ROOT = opts.onecServiceRoot;
  if (opts.host) process.env.MCP_HOST = opts.host;
  if (opts.port) process.env.MCP_PORT = opts.port;
  if (opts.logLevel) process.env.MCP_LOG_LEVEL = opts.logLevel;
  if (opts.authMode) process.env.MCP_AUTH_MODE = opts.authMode;
  if (opts.publicUrl) process.env.MCP_PUBLIC_URL = opts.publicUrl;

  // Получаем конфигурацию
  let config;
  try {
    config = getConfig();
  } catch (e) {
    process.stderr.write(`Ошибка конфигурации: ${String(e)}\n`);
    process.stderr.write("\nПроверьте, что указаны все обязательные параметры:\n");
    process.stderr.write("- MCP_ONEC_URL (URL базы 1С)\n");
    process.exit(1);
  }

  // Настройка логирования
  setLogLevel(config.logLevel);

  // Валидация режима авторизации
  if (mode === "stdio" && config.authMode === "oauth2") {
    logger.error("OAuth2 не поддерживается в режиме stdio. Используйте auth_mode=none.");
    process.exit(1);
  }

  if (config.authMode === "none") {
    if (!config.onecUsername) {
      logger.error("Для auth_mode=none обязателен MCP_ONEC_USERNAME.");
      process.exit(1);
    }
  } else {
    if (config.onecUsername) {
      logger.info(
        "MCP_ONEC_USERNAME задан в режиме oauth2 — будет использован для загрузки instructions.",
      );
    }
  }

  // Предупреждение о небезопасном CORS
  if (mode === "http" && config.corsOrigins.includes("*")) {
    logger.warning(
      'CORS настроен на прием запросов с любого домена ("*"). Для production рекомендуется ограничить MCP_CORS_ORIGINS.',
    );
  }

  logger.debug(`Режим работы: ${mode}`);
  logger.debug(`Подключение к 1С: ${config.onecUrl}`);

  try {
    if (mode === "stdio") {
      await runStdioServer(config);
    } else if (mode === "http") {
      logger.debug(`HTTP-сервер будет запущен на ${config.host}:${config.port}`);
      await runHttpServer(config);
    } else {
      logger.error(`Неизвестный режим: ${mode}`);
      process.exit(1);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return;
    logger.error("Критическая ошибка", e);
    process.exit(1);
  }
}
