/**
 * Интеграционные тесты жизненного цикла сессий Streamable HTTP на /mcp.
 *
 * Поднимается мок 1С (health + JSON-RPC) и реальный HTTP-сервер приложения
 * на эфемерном порту. Проверяется спецификация MCP: 404 для неизвестных
 * сессий, прозрачная переинициализация и то, что открытый SSE-стрим
 * удерживает сессию от вычистки по TTL.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpApp, type HttpAppHandle } from "../src/http-server.js";
import { setLogLevel } from "../src/logger.js";
import type { Config } from "../src/config.js";

// --- Мок 1С ---

let onecServer: Server;
let onecUrl: string;

// --- Приложение ---

let handle: HttpAppHandle;
let appServer: Server;
let baseUrl: string;

const SESSION_TTL_MS = 200; // маленький TTL, чтобы тесты не ждали минуты

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    onecUrl,
    onecUsername: "admin",
    onecPassword: "pass",
    onecServiceRoot: "mcp",
    onecTimeout: 5000,
    serverName: "test-mcp",
    serverVersion: "0.0.0",
    logLevel: "ERROR",
    corsOrigins: ["*"],
    authMode: "none",
    publicUrl: undefined,
    oauth2CodeTtl: 120,
    oauth2AccessTtl: 3600,
    oauth2RefreshTtl: 1209600,
    oauth2StorePath: undefined,
    oauth2RefreshGraceMs: 60_000,
    authRateLimitMaxAttempts: 5,
    authRateLimitWindowMs: 900_000,
    authRateLimitBlockMs: 60_000,
    authRateLimitByIp: true,
    trustProxy: undefined,
    sessionTtlMs: SESSION_TTL_MS,
    maxSessions: 1000,
    saveFileDir: undefined,
    allowedHosts: [],
    ...overrides,
  };
}

/** Поднимает отдельный экземпляр приложения на эфемерном порту. */
async function startApp(
  overrides: Partial<Config>,
): Promise<{ handle: HttpAppHandle; server: Server; port: number; stop: () => Promise<void> }> {
  const h = await createHttpApp(makeConfig(overrides));
  const srv = createServer(h.app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    handle: h,
    server: srv,
    port,
    stop: async () => {
      await h.dispose();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    },
  };
}

/** HTTP-запрос с полным контролем заголовков (fetch запрещает host/origin). */
function rawRequest(
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let healthHits = 0;

beforeAll(async () => {
  // Мок 1С: health отвечает ok, JSON-RPC отвечает пустыми списками,
  // /files/* отдает бинарное содержимое с Content-Disposition
  onecServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/health")) {
        healthHits++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url?.includes("/files/")) {
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-disposition", 'attachment; filename="task.bin"');
        res.end("DATA");
        return;
      }
      res.setHeader("content-type", "application/json");
      let id: unknown = null;
      try {
        id = (JSON.parse(body) as { id?: unknown }).id ?? null;
      } catch {
        // пустое тело
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { instructions: "test", tools: [], resources: [], prompts: [] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => onecServer.listen(0, "127.0.0.1", resolve));
  onecUrl = `http://127.0.0.1:${(onecServer.address() as AddressInfo).port}`;

  handle = await createHttpApp(makeConfig());
  appServer = createServer(handle.app);
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await handle.dispose();
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => onecServer.close(() => resolve()));
});

// --- Хелперы ---

const ACCEPT = "application/json, text/event-stream";

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
}

function toolsListBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}

async function initializeSession(base: string = baseUrl): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT },
    body: initializeBody(),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await res.body?.cancel();
  return sessionId as string;
}

/** Извлекает JSON-RPC сообщение из SSE-ответа POST /mcp. */
async function readSseResult(res: Response): Promise<unknown> {
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : undefined;
}

async function postToSession(sessionId: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-session-id": sessionId,
    },
    body,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Тесты ---

describe("/mcp — создание сессии", () => {
  it("initialize без session id создаёт сессию и возвращает Mcp-Session-Id", async () => {
    const sessionId = await initializeSession();
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it("initialize с устаревшим session id создаёт новую сессию (прозрачное восстановление)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      },
      body: initializeBody(),
    });
    expect(res.status).toBe(200);
    const newId = res.headers.get("mcp-session-id");
    expect(newId).toBeTruthy();
    expect(newId).not.toBe("00000000-0000-0000-0000-000000000000");
    await res.body?.cancel();
  });
});

describe("/mcp — неизвестная сессия (спецификация MCP)", () => {
  it("POST с неизвестным session id отвечает 404 и кодом -32001", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": "11111111-1111-1111-1111-111111111111",
      },
      body: toolsListBody(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });

  it("GET с неизвестным session id отвечает 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": "22222222-2222-2222-2222-222222222222",
      },
    });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("DELETE с неизвестным session id отвечает 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "33333333-3333-3333-3333-333333333333" },
    });
    expect(res.status).toBe(404);
  });

  it("POST без session id и не-initialize отвечает 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: toolsListBody(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
  });
});

describe("лимиты тела запроса", () => {
  it("большое тело на не-/mcp эндпоинт отвергается с 413", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "a".repeat(200_000) }),
    });
    expect(res.status).toBe(413);
  });

  it("/mcp принимает большое тело (лимит 50mb)", async () => {
    const body = JSON.parse(initializeBody()) as {
      params: { clientInfo: Record<string, unknown> };
    };
    body.params.clientInfo.pad = "a".repeat(200_000);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});

describe("кап количества сессий", () => {
  it("при превышении лимита вытесняется самая старая сессия", async () => {
    const h2 = await createHttpApp(makeConfig({ maxSessions: 2, sessionTtlMs: 60_000 }));
    const srv2 = createServer(h2.app);
    await new Promise<void>((resolve) => srv2.listen(0, "127.0.0.1", resolve));
    const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;

    try {
      const s1 = await initializeSession(base2);
      const s2 = await initializeSession(base2);
      const s3 = await initializeSession(base2);

      const check = async (sid: string) =>
        fetch(`${base2}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: ACCEPT,
            "mcp-session-id": sid,
          },
          body: toolsListBody(),
        });

      const r1 = await check(s1);
      expect(r1.status).toBe(404); // самая старая вытеснена

      const r2 = await check(s2);
      expect(r2.status).toBe(200);
      await r2.body?.cancel();

      const r3 = await check(s3);
      expect(r3.status).toBe(200);
      await r3.body?.cancel();
    } finally {
      await h2.dispose();
      await new Promise<void>((resolve) => srv2.close(() => resolve()));
    }
  });
});

describe("кэширование health-check при создании сессии", () => {
  it("повторные initialize не порождают шторм health-check'ов в 1С", async () => {
    const before = healthHits;
    await initializeSession();
    await initializeSession();
    // Кэш валидатора (10 сек) — максимум один реальный health-check
    expect(healthHits - before).toBeLessThanOrEqual(1);
  });
});

describe("save_file — ограничение каталога записи", () => {
  async function callSaveFile(sessionId: string, args: Record<string, unknown>) {
    const res = await postToSession(
      sessionId,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "save_file", arguments: args },
      }),
    );
    expect(res.status).toBe(200);
    return (await readSseResult(res)) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
  }

  it("в HTTP-режиме запись по произвольному пути отклоняется", async () => {
    const sessionId = await initializeSession();
    const outside = process.platform === "win32" ? "C:\\evil-dir\\evil.bin" : "/etc/evil.bin";
    const msg = await callSaveFile(sessionId, { file_id: "ref_files_a", path: outside });
    expect(msg.result?.isError).toBe(true);
    expect(msg.result?.content?.[0]?.text).toMatch(/outside/i);
  });

  it("в HTTP-режиме файл без path сохраняется в служебный каталог", async () => {
    const sessionId = await initializeSession();
    const msg = await callSaveFile(sessionId, { file_id: "ref_files_b" });
    expect(msg.result?.isError).toBe(false);
    const payload = JSON.parse(msg.result?.content?.[0]?.text ?? "{}") as { path?: string };
    expect(payload.path).toContain("mcp-files");
  });
});

describe("CORS", () => {
  it("отдаёт Access-Control-Allow-Origin только разрешённому origin", async () => {
    const app2 = await startApp({ corsOrigins: ["https://good.example"] });
    try {
      const good = await rawRequest(app2.port, {
        path: "/info",
        headers: { origin: "https://good.example" },
      });
      expect(good.headers["access-control-allow-origin"]).toBe("https://good.example");
      expect(good.headers["access-control-allow-credentials"]).toBe("true");

      const evil = await rawRequest(app2.port, {
        path: "/info",
        headers: { origin: "https://evil.example" },
      });
      expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
      expect(evil.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await app2.stop();
    }
  });

  it("wildcard отдаёт * без credentials", async () => {
    const res = await rawRequest((appServer.address() as AddressInfo).port, {
      path: "/info",
      headers: { origin: "https://anything.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("защита от DNS rebinding (MCP_ALLOWED_HOSTS)", () => {
  it("запрос с чужим Host отклоняется 403, разрешённый проходит", async () => {
    const app2 = await startApp({ allowedHosts: ["localhost"] });
    try {
      const ok = await rawRequest(app2.port, {
        path: "/info",
        headers: { host: "localhost:8000" },
      });
      expect(ok.status).toBe(200);

      const rebind = await rawRequest(app2.port, {
        path: "/info",
        headers: { host: "attacker.example" },
      });
      expect(rebind.status).toBe(403);
    } finally {
      await app2.stop();
    }
  });

  it("без настройки проверка Host отключена", async () => {
    const res = await rawRequest((appServer.address() as AddressInfo).port, {
      path: "/info",
      headers: { host: "anything.example" },
    });
    expect(res.status).toBe(200);
  });
});

describe("request-логирование", () => {
  it("ответы с ошибкой логируются на WARNING", async () => {
    setLogLevel("WARNING"); // setup.ts глушит тестовый прогон уровнем ERROR
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: ACCEPT,
          "mcp-session-id": "99999999-9999-9999-9999-999999999999",
        },
        body: toolsListBody(),
      });
      expect(res.status).toBe(404);
      await sleep(100); // лог пишется по закрытию ответа
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("WARNING") && l.includes("POST /mcp 404"))).toBe(true);
    } finally {
      spy.mockRestore();
      setLogLevel("ERROR");
    }
  });

  it("успешные запросы логируются на DEBUG", async () => {
    setLogLevel("DEBUG");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await fetch(`${baseUrl}/info`);
      expect(res.status).toBe(200);
      await sleep(100);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("DEBUG") && l.includes("GET /info 200"))).toBe(true);
    } finally {
      spy.mockRestore();
      setLogLevel("ERROR");
    }
  });
});

describe("/mcp — TTL сессий", () => {
  it("сессия без активности вычищается по TTL, следующий запрос получает 404", async () => {
    const sessionId = await initializeSession();
    await sleep(SESSION_TTL_MS * 3 + 100);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": sessionId,
      },
      body: toolsListBody(),
    });
    expect(res.status).toBe(404);
  });

  it("сессия с открытым SSE-стримом переживает TTL", async () => {
    const sessionId = await initializeSession();

    // Открываем standalone SSE-стрим и держим его открытым
    const abort = new AbortController();
    const ssePromise = fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
      signal: abort.signal,
    });
    const sseRes = await ssePromise;
    expect(sseRes.status).toBe(200);

    // Ждём заметно дольше TTL: с открытым стримом сессия должна жить
    await sleep(SESSION_TTL_MS * 3 + 100);

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": sessionId,
      },
      body: toolsListBody(),
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();

    abort.abort();

    // После закрытия стрима сессия истекает по TTL как обычно
    await sleep(SESSION_TTL_MS * 3 + 100);
    const res2 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": sessionId,
      },
      body: toolsListBody(),
    });
    expect(res2.status).toBe(404);
  });
});

describe("недоступность 1С: подробный текст ошибки", () => {
  const IIS_500 = `<html><head><title>IIS 10.0 — 500.0 — Internal Server Error</title></head><body>
<h2>Подробные сведения об ошибке:</h2><table>
<tr><th>Модуль</th><td>&nbsp;&nbsp;&nbsp;<code>IsapiModule</code></td></tr>
<tr><th>Уведомление</th><td>&nbsp;&nbsp;&nbsp;<code>ExecuteRequestHandler</code></td></tr>
<tr><th>Обработчик</th><td>&nbsp;&nbsp;&nbsp;<code>1C Web-service Extension</code></td></tr>
<tr><th>Код ошибки</th><td>&nbsp;&nbsp;&nbsp;<code>0x80004005</code></td></tr>
<tr><th>Физический путь</th><td>&nbsp;&nbsp;&nbsp;C:/inetpub/wwwroot/tracker/hs/mcp/health</td></tr>
<tr><th>Метод входа</th><td>&nbsp;&nbsp;&nbsp;Анонимная</td></tr>
</table></body></html>`;
  const SUMMARY = "HTTP 500: IsapiModule / 1C Web-service Extension / 0x80004005";

  let failingStatus = 500;
  let failingServer: Server;
  let failingUrl: string;

  beforeAll(async () => {
    failingServer = createServer((req, res) => {
      req.resume();
      res.statusCode = failingStatus;
      res.setHeader("content-type", failingStatus === 500 ? "text/html" : "text/plain");
      res.end(failingStatus === 500 ? IIS_500 : "");
    });
    await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    failingUrl = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => failingServer.close(() => resolve()));
  });

  it("initialize: 503 с модулем, обработчиком и кодом ошибки IIS, без путей", async () => {
    failingStatus = 500;
    const app = await startApp({ onecUrl: failingUrl });
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: initializeBody(),
      });
      expect(res.status).toBe(503);
      const text = await res.text();
      const body = JSON.parse(text) as { error: { code: number; message: string } };
      expect(body.error.message).toContain(
        `1C service unavailable: ${SUMMARY}. Вероятно, информационную базу 1С необходимо опубликовать на веб-сервере`,
      );
      expect(text).not.toMatch(/inetpub|127\.0\.0\.1/);
    } finally {
      await app.stop();
    }
  });

  it("initialize: ответ 401 от 1С остаётся ошибкой авторизации, а не недоступностью", async () => {
    failingStatus = 401;
    const app = await startApp({ onecUrl: failingUrl });
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: initializeBody(),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    } finally {
      await app.stop();
    }
  });

  it("initialize: текст «HTTP 401» в теле ответа 502 не превращает сбой в ошибку авторизации", async () => {
    const proxyServer = createServer((req, res) => {
      req.resume();
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end("backend answered HTTP 401");
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
    const app = await startApp({ onecUrl: url });
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: initializeBody(),
      });
      expect(res.status).toBe(503);
    } finally {
      await app.stop();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }
  });

  it("страница входа OAuth2: сводка ошибки 1С видна, пути и адреса — нет", async () => {
    failingStatus = 500;
    const app = await startApp({
      onecUrl: failingUrl,
      authMode: "oauth2",
      onecUsername: "",
      onecPassword: "",
    });
    try {
      const qs = new URLSearchParams({
        redirect_uri: "http://localhost/cb",
        code_challenge: "x".repeat(43),
      });
      const res = await fetch(`http://127.0.0.1:${app.port}/authorize?${qs.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "u", password: "p" }),
      });
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain("IsapiModule / 1C Web-service Extension / 0x80004005");
      expect(html).toContain("необходимо опубликовать на веб-сервере");
      expect(html).not.toMatch(/inetpub|127\.0\.0\.1/);
    } finally {
      await app.stop();
    }
  });

  it("initialize: отказ в соединении даёт код ошибки и подсказку про MCP_ONEC_URL", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const app = await startApp({ onecUrl: url });
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: initializeBody(),
      });
      expect(res.status).toBe(503);
      const text = await res.text();
      const body = JSON.parse(text) as { error: { message: string } };
      expect(body.error.message).toContain("ECONNREFUSED");
      expect(body.error.message).toContain("MCP_ONEC_URL");
      expect(text).not.toContain("127.0.0.1");
    } finally {
      await app.stop();
    }
  });

  it("tools/call при сбое 1С возвращает сводку и подсказку без стека", async () => {
    const half = createServer((req, res) => {
      req.resume();
      if (req.url?.endsWith("/health")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.statusCode = 500;
      res.setHeader("content-type", "text/html");
      res.end(IIS_500);
    });
    await new Promise<void>((resolve) => half.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(half.address() as AddressInfo).port}`;
    const app = await startApp({ onecUrl: url });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const init = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: initializeBody(),
      });
      const sessionId = init.headers.get("mcp-session-id") as string;
      await init.body?.cancel();

      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: ACCEPT,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_task", arguments: {} },
        }),
      });
      const msg = (await readSseResult(res)) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = msg.result.content[0]?.text ?? "";
      expect(msg.result.isError).toBe(true);
      expect(text).toContain(SUMMARY);
      expect(text).toContain("необходимо опубликовать на веб-сервере");
      expect(text).not.toMatch(/\n\s+at /);
    } finally {
      await app.stop();
      await new Promise<void>((resolve) => half.close(() => resolve()));
    }
  });
});
