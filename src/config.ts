/**
 * Конфигурация MCP-прокси сервера.
 */

import { createRequire } from "node:module";
import { z } from "zod";

const require = createRequire(import.meta.url);
export const { version: PACKAGE_VERSION } = require("../package.json") as { version: string };

const configSchema = z.object({
  // Настройки сервера
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(8000),

  // Настройки подключения к 1С
  onecUrl: z.url(),
  onecUsername: z.string().optional(),
  onecPassword: z.string().default(""),
  onecServiceRoot: z.string().default("mcp"),
  onecTimeout: z.coerce.number().int().min(1000).default(120_000),

  // Настройки MCP
  serverName: z.string().default("Управление IT-отделом 8 MCP"),
  serverVersion: z.string().default(PACKAGE_VERSION),

  // Настройки логирования
  logLevel: z.enum(["DEBUG", "INFO", "WARNING", "ERROR"]).default("INFO"),

  // Настройки безопасности
  corsOrigins: z.array(z.string()).default(["*"]),

  // Настройки авторизации OAuth2
  authMode: z.enum(["none", "oauth2"]).default("none"),
  publicUrl: z.string().optional(),
  oauth2CodeTtl: z.coerce.number().int().default(120),
  oauth2AccessTtl: z.coerce.number().int().default(3600),
  oauth2RefreshTtl: z.coerce.number().int().default(1209600),
  /** Путь к JSON-снапшоту OAuth2-токенов; если не задан — токены только в памяти. */
  oauth2StorePath: z.string().optional(),
  /** Окно идемпотентности при ротации refresh-токена (мс). */
  oauth2RefreshGraceMs: z.coerce.number().int().min(0).default(60_000),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Чтение переменной окружения с префиксом MCP_.
 */
function env(key: string): string | undefined {
  return process.env[`MCP_${key}`];
}

/**
 * Получить конфигурацию из переменных окружения.
 */
export function getConfig(): Config {
  let corsOrigins: string[] = ["*"];
  const corsRaw = env("CORS_ORIGINS");
  if (corsRaw) {
    try {
      corsOrigins = JSON.parse(corsRaw);
    } catch {
      corsOrigins = [corsRaw];
    }
  }

  const raw = {
    host: env("HOST"),
    port: env("PORT"),
    onecUrl: env("ONEC_URL"),
    onecUsername: env("ONEC_USERNAME"),
    onecPassword: env("ONEC_PASSWORD"),
    onecServiceRoot: env("ONEC_SERVICE_ROOT"),
    onecTimeout: env("ONEC_TIMEOUT"),
    serverName: env("SERVER_NAME"),
    serverVersion: undefined,
    logLevel: env("LOG_LEVEL"),
    corsOrigins,
    authMode: env("AUTH_MODE"),
    publicUrl: env("PUBLIC_URL"),
    oauth2CodeTtl: env("OAUTH2_CODE_TTL"),
    oauth2AccessTtl: env("OAUTH2_ACCESS_TTL"),
    oauth2RefreshTtl: env("OAUTH2_REFRESH_TTL"),
    oauth2StorePath: env("OAUTH2_STORE_PATH"),
    oauth2RefreshGraceMs: env("OAUTH2_REFRESH_GRACE_MS"),
  };

  // Удаляем undefined значения, чтобы zod использовал defaults
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined)
  );

  return configSchema.parse(cleaned);
}
