import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OneCClient } from "../src/onec-client.js";

interface MockResponse {
  status: number;
  json?: unknown;
  raw?: string;
}

interface CapturedRequest {
  url?: string;
  method?: string;
  auth?: string;
  body: string;
}

let server: Server;
let baseUrl: string;
let lastRequest: CapturedRequest;
let responder: (req: CapturedRequest) => MockResponse;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = {
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
        body,
      };
      const r = responder(lastRequest);
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(r.raw ?? JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("OneCClient.buildServiceUrl", () => {
  it("нормализует слэши и собирает путь /hs/<root>", () => {
    expect(OneCClient.buildServiceUrl("http://host/base/", "/mcp/")).toBe(
      "http://host/base/hs/mcp",
    );
  });
});

describe("OneCClient — health", () => {
  it("checkHealth возвращает true при {status:'ok'}", async () => {
    responder = () => ({ status: 200, json: { status: "ok" } });
    const client = new OneCClient(baseUrl, "admin", "pass");
    await expect(client.checkHealth()).resolves.toBe(true);
    await client.close();
  });

  it("формирует корректный Basic Auth заголовок", async () => {
    responder = () => ({ status: 200, json: { status: "ok" } });
    const client = new OneCClient(baseUrl, "admin", "secret");
    await client.checkHealth();
    const expected = "Basic " + Buffer.from("admin:secret").toString("base64");
    expect(lastRequest.auth).toBe(expected);
    await client.close();
  });

  it("checkHealth бросает при HTTP 503", async () => {
    responder = () => ({ status: 503, json: {} });
    const client = new OneCClient(baseUrl, "a", "b");
    await expect(client.checkHealth()).rejects.toThrow(/HTTP 503/);
    await client.close();
  });

  it("checkHealth бросает, если статус не 'ok'", async () => {
    responder = () => ({ status: 200, json: { status: "degraded" } });
    const client = new OneCClient(baseUrl, "a", "b");
    await expect(client.checkHealth()).rejects.toThrow(/not healthy/);
    await client.close();
  });
});

describe("OneCClient — JSON-RPC", () => {
  it("callRpc отправляет валидный JSON-RPC 2.0 POST и возвращает result", async () => {
    responder = () => ({
      status: 200,
      json: { jsonrpc: "2.0", id: 1, result: { ok: true } },
    });
    const client = new OneCClient(baseUrl, "a", "b");
    const result = await client.callRpc("tools/list", { foo: "bar" });
    expect(result).toEqual({ ok: true });

    const sent = JSON.parse(lastRequest.body) as Record<string, unknown>;
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("tools/list");
    expect(sent.params).toEqual({ foo: "bar" });
    expect(lastRequest.method).toBe("POST");
    await client.close();
  });

  it("callRpc пробрасывает JSON-RPC ошибку как исключение", async () => {
    responder = () => ({
      status: 200,
      json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } },
    });
    const client = new OneCClient(baseUrl, "a", "b");
    await expect(client.callRpc("x")).rejects.toThrow(/boom/);
    await client.close();
  });

  it("callRpc бросает на невалидном JSON-ответе", async () => {
    responder = () => ({ status: 200, raw: "<html>not json</html>" });
    const client = new OneCClient(baseUrl, "a", "b");
    await expect(client.callRpc("x")).rejects.toThrow(/Невалидный JSON/);
    await client.close();
  });

  it("listTools подставляет дефолты description и inputSchema", async () => {
    responder = () => ({
      status: 200,
      json: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "t1" }] } },
    });
    const client = new OneCClient(baseUrl, "a", "b");
    const { tools } = await client.listTools();
    expect(tools[0]).toMatchObject({ name: "t1", description: "", inputSchema: {} });
    await client.close();
  });

  it("callTool маппит text и image контент", async () => {
    responder = () => ({
      status: 200,
      json: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "AAA", mimeType: "image/jpeg" },
          ],
          isError: false,
        },
      },
    });
    const client = new OneCClient(baseUrl, "a", "b");
    const res = await client.callTool("tool", {});
    expect(res.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/jpeg" },
    ]);
    expect(res.isError).toBe(false);
    await client.close();
  });
});

describe("OneCClient — жизненный цикл", () => {
  it("после close() запросы бросают исключение", async () => {
    responder = () => ({ status: 200, json: { status: "ok" } });
    const client = new OneCClient(baseUrl, "a", "b");
    await client.close();
    await expect(client.checkHealth()).rejects.toThrow(/закрыт/);
  });
});
