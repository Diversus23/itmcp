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
    expect(cfg.oauth2RefreshGraceMs).toBe(60_000);
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
});
