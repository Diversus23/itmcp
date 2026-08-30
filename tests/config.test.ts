import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig, PACKAGE_VERSION } from "../src/config.js";

// Все переменные окружения, которые читает getConfig — изолируем их между тестами,
// чтобы окружение запуска (CI/локально) не влияло на результат.
const MCP_KEYS = [
  "MCP_HOST",
  "MCP_PORT",
  "MCP_ONEC_URL",
  "MCP_ONEC_USERNAME",
  "MCP_ONEC_PASSWORD",
  "MCP_ONEC_SERVICE_ROOT",
  "MCP_ONEC_TIMEOUT",
  "MCP_SERVER_NAME",
  "MCP_LOG_LEVEL",
  "MCP_CORS_ORIGINS",
  "MCP_AUTH_MODE",
  "MCP_PUBLIC_URL",
  "MCP_OAUTH2_CODE_TTL",
  "MCP_OAUTH2_ACCESS_TTL",
  "MCP_OAUTH2_REFRESH_TTL",
  "MCP_OAUTH2_STORE_PATH",
  "MCP_OAUTH2_REFRESH_GRACE_MS",
  "MCP_OAUTH2_REVOKE_ON_REUSE",
  "MCP_AUTH_RATE_LIMIT_MAX_ATTEMPTS",
  "MCP_AUTH_RATE_LIMIT_WINDOW_MS",
  "MCP_AUTH_RATE_LIMIT_BLOCK_MS",
  "MCP_AUTH_RATE_LIMIT_BY_IP",
  "MCP_TRUST_PROXY",
  "MCP_SESSION_TTL_MS",
  "MCP_MAX_SESSIONS",
  "MCP_SAVE_FILE_DIR",
  "MCP_ALLOWED_HOSTS",
];

describe("getConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of MCP_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of MCP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("требует MCP_ONEC_URL", () => {
    expect(() => getConfig()).toThrow();
  });

  it("отвергает некорректный URL", () => {
    process.env.MCP_ONEC_URL = "not-a-url";
    expect(() => getConfig()).toThrow();
  });

  it("заполняет значения по умолчанию при минимальной конфигурации", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    const cfg = getConfig();
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(8000);
    expect(cfg.authMode).toBe("none");
    expect(cfg.onecServiceRoot).toBe("mcp");
    expect(cfg.onecTimeout).toBe(120_000);
    expect(cfg.logLevel).toBe("INFO");
    expect(cfg.corsOrigins).toEqual(["*"]);
    expect(cfg.serverVersion).toBe(PACKAGE_VERSION);
    expect(cfg.oauth2RefreshGraceMs).toBe(300_000);
    expect(cfg.oauth2RevokeOnReuse).toBe(false);
  });

  it("включает строгий режим отзыва семьи через MCP_OAUTH2_REVOKE_ON_REUSE", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_OAUTH2_REVOKE_ON_REUSE = "true";
    expect(getConfig().oauth2RevokeOnReuse).toBe(true);
  });

  it("трактует MCP_OAUTH2_REVOKE_ON_REUSE=false как выключенный строгий режим", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_OAUTH2_REVOKE_ON_REUSE = "false";
    expect(getConfig().oauth2RevokeOnReuse).toBe(false);
  });

  it("приводит порт из строки к числу", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_PORT = "9001";
    expect(getConfig().port).toBe(9001);
  });

  it("отвергает порт вне диапазона 1..65535", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_PORT = "70000";
    expect(() => getConfig()).toThrow();
  });

  it("парсит MCP_CORS_ORIGINS как JSON-массив", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_CORS_ORIGINS = '["https://a.example","https://b.example"]';
    expect(getConfig().corsOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("оборачивает не-JSON значение CORS в массив из одного origin", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_CORS_ORIGINS = "https://single.example";
    expect(getConfig().corsOrigins).toEqual(["https://single.example"]);
  });

  it("отвергает неизвестный authMode", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_MODE = "bogus";
    expect(() => getConfig()).toThrow();
  });

  it("принимает authMode=oauth2", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_MODE = "oauth2";
    expect(getConfig().authMode).toBe("oauth2");
  });

  it("отвергает неизвестный уровень логирования", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_LOG_LEVEL = "TRACE";
    expect(() => getConfig()).toThrow();
  });

  it("задаёт значения rate-limit по умолчанию", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    const cfg = getConfig();
    expect(cfg.authRateLimitMaxAttempts).toBe(5);
    expect(cfg.authRateLimitWindowMs).toBe(900_000);
    expect(cfg.authRateLimitBlockMs).toBe(60_000);
  });

  it("читает параметры rate-limit из окружения", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "10";
    process.env.MCP_AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MCP_AUTH_RATE_LIMIT_BLOCK_MS = "30000";
    const cfg = getConfig();
    expect(cfg.authRateLimitMaxAttempts).toBe(10);
    expect(cfg.authRateLimitWindowMs).toBe(60_000);
    expect(cfg.authRateLimitBlockMs).toBe(30_000);
  });

  it("принимает 0 как отключение rate-limit", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "0";
    expect(getConfig().authRateLimitMaxAttempts).toBe(0);
  });

  it("учёт по IP включен по умолчанию", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    expect(getConfig().authRateLimitByIp).toBe(true);
  });

  it("MCP_AUTH_RATE_LIMIT_BY_IP=false отключает учёт по IP", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_RATE_LIMIT_BY_IP = "false";
    expect(getConfig().authRateLimitByIp).toBe(false);
  });

  it("MCP_AUTH_RATE_LIMIT_BY_IP=0 отключает учёт по IP", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_RATE_LIMIT_BY_IP = "0";
    expect(getConfig().authRateLimitByIp).toBe(false);
  });

  it("MCP_AUTH_RATE_LIMIT_BY_IP=true оставляет учёт по IP включенным", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_RATE_LIMIT_BY_IP = "true";
    expect(getConfig().authRateLimitByIp).toBe(true);
  });

  it("отвергает отрицательный лимит попыток", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "-1";
    expect(() => getConfig()).toThrow();
  });

  it("sessionTtlMs по умолчанию 24 часа", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    expect(getConfig().sessionTtlMs).toBe(86_400_000);
  });

  it("читает MCP_SESSION_TTL_MS из окружения", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_SESSION_TTL_MS = "3600000";
    expect(getConfig().sessionTtlMs).toBe(3_600_000);
  });

  it("отвергает MCP_SESSION_TTL_MS меньше 1000 мс", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_SESSION_TTL_MS = "500";
    expect(() => getConfig()).toThrow();
  });

  it("maxSessions по умолчанию 1000", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    expect(getConfig().maxSessions).toBe(1000);
  });

  it("читает MCP_MAX_SESSIONS из окружения", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_MAX_SESSIONS = "50";
    expect(getConfig().maxSessions).toBe(50);
  });

  it("отвергает MCP_MAX_SESSIONS меньше 1", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_MAX_SESSIONS = "0";
    expect(() => getConfig()).toThrow();
  });

  it("saveFileDir по умолчанию не задан", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    expect(getConfig().saveFileDir).toBeUndefined();
  });

  it("читает MCP_SAVE_FILE_DIR из окружения", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_SAVE_FILE_DIR = "/srv/mcp-files";
    expect(getConfig().saveFileDir).toBe("/srv/mcp-files");
  });

  it("allowedHosts по умолчанию пуст (проверка Host отключена)", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    expect(getConfig().allowedHosts).toEqual([]);
  });

  it("парсит MCP_ALLOWED_HOSTS как JSON-массив", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_ALLOWED_HOSTS = '["localhost","mcp.example.com"]';
    expect(getConfig().allowedHosts).toEqual(["localhost", "mcp.example.com"]);
  });

  it("оборачивает не-JSON значение MCP_ALLOWED_HOSTS в массив из одного хоста", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_ALLOWED_HOSTS = "mcp.example.com";
    expect(getConfig().allowedHosts).toEqual(["mcp.example.com"]);
  });

  it("trustProxy по умолчанию не задан", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    expect(getConfig().trustProxy).toBeUndefined();
  });

  it("парсит MCP_TRUST_PROXY=true как boolean", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_TRUST_PROXY = "true";
    expect(getConfig().trustProxy).toBe(true);
  });

  it("парсит числовой MCP_TRUST_PROXY как число прокси-хопов", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_TRUST_PROXY = "2";
    expect(getConfig().trustProxy).toBe(2);
  });

  it("передаёт строковый MCP_TRUST_PROXY как есть (например, loopback)", () => {
    process.env.MCP_ONEC_URL = "http://localhost/base";
    process.env.MCP_TRUST_PROXY = "loopback";
    expect(getConfig().trustProxy).toBe("loopback");
  });
});
