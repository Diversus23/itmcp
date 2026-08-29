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

function makeConfig(): Config {
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
  };
}

beforeAll(async () => {
  // Мок 1С: health отвечает ok, JSON-RPC отвечает пустыми списками
  onecServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/health")) {
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
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

async function initializeSession(): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
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
