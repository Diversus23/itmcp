/**
 * Интеграционные тесты жизненного цикла сессий Streamable HTTP на /mcp.
 *
 * Поднимается мок 1С (health + JSON-RPC) и реальный HTTP-сервер приложения
 * на эфемерном порту. Проверяется спецификация MCP: 404 для неизвестных
 * сессий, прозрачная переинициализация и то, что открытый SSE-стрим
 * удерживает сессию от вычистки по TTL.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpApp, type HttpAppHandle } from "../src/http-server.js";
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
    ...overrides,
  };
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
