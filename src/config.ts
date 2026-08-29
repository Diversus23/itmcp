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
  /**
   * TTL HTTP-сессии /mcp без активности (мс). Сессия с открытым SSE-стримом
   * считается активной и по TTL не вычищается.
   */
  sessionTtlMs: z.coerce.number().int().min(1000).default(86_400_000),
  /**
   * Максимум одновременных HTTP-сессий /mcp; при превышении вытесняется
   * самая старая неактивная сессия (защита памяти от initialize-штормов).
   */
  maxSessions: z.coerce.number().int().min(1).default(1000),
  /**
   * Белый каталог для инструмента save_file. Если задан — файлы пишутся
   * только внутрь него. В HTTP-режиме без настройки используется
   * служебный каталог во временной директории.
   */
  saveFileDir: z.string().optional(),

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

  // Защита от перебора паролей (rate limiting на /authorize и /token)
  /** Неудачных попыток до блокировки; 0 — отключить rate limiting. */
  authRateLimitMaxAttempts: z.coerce.number().int().min(0).default(5),
  /** Окно накопления неудачных попыток (мс). */
  authRateLimitWindowMs: z.coerce.number().int().min(1000).default(900_000),
  /** Базовая длительность блокировки (мс); удваивается при повторных сериях. */
  authRateLimitBlockMs: z.coerce.number().int().min(1000).default(60_000),
  /**
   * Учитывать ли IP клиента при подсчёте неудачных попыток. Отключайте
   * ("false"/"0") только там, где все клиенты видны с одного адреса
   * (Docker Desktop, прокси без X-Forwarded-For) — останется учёт по логину.
   */
  authRateLimitByIp: z
    .string()
    .optional()
    .transform((v) => v === undefined || !["false", "0", "no", "off"].includes(v.toLowerCase())),

  /**
   * Значение для express "trust proxy": true, число хопов или строка
   * ("loopback", список IP). Обязателен за reverse proxy, иначе rate limiting
   * по IP будет считать все запросы пришедшими с адреса прокси.
   */
  trustProxy: z
    .string()
    .optional()
    .transform((v): boolean | number | string | undefined => {
      if (v === undefined) return undefined;
      if (v === "true") return true;
      if (/^\d+$/.test(v)) return Number(v);
      return v;
    }),
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
    sessionTtlMs: env("SESSION_TTL_MS"),
    maxSessions: env("MAX_SESSIONS"),
    saveFileDir: env("SAVE_FILE_DIR"),
    logLevel: env("LOG_LEVEL"),
    corsOrigins,
    authMode: env("AUTH_MODE"),
    publicUrl: env("PUBLIC_URL"),
    oauth2CodeTtl: env("OAUTH2_CODE_TTL"),
    oauth2AccessTtl: env("OAUTH2_ACCESS_TTL"),
    oauth2RefreshTtl: env("OAUTH2_REFRESH_TTL"),
    oauth2StorePath: env("OAUTH2_STORE_PATH"),
    oauth2RefreshGraceMs: env("OAUTH2_REFRESH_GRACE_MS"),
    authRateLimitMaxAttempts: env("AUTH_RATE_LIMIT_MAX_ATTEMPTS"),
    authRateLimitWindowMs: env("AUTH_RATE_LIMIT_WINDOW_MS"),
    authRateLimitBlockMs: env("AUTH_RATE_LIMIT_BLOCK_MS"),
    authRateLimitByIp: env("AUTH_RATE_LIMIT_BY_IP"),
    trustProxy: env("TRUST_PROXY"),
  };

  // Удаляем undefined значения, чтобы zod использовал defaults
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));

  return configSchema.parse(cleaned);
}
