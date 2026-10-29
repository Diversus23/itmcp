import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OneCClient,
  OneCConnectionError,
  OneCHttpError,
  formatOneCError,
} from "../src/onec-client.js";

interface MockResponse {
  status: number;
  json?: unknown;
  raw?: string;
  contentType?: string;
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
      res.setHeader("content-type", r.contentType ?? "application/json");
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

/** Страница ошибки IIS 10 (локаль ru-RU), как её отдаёт сломанная публикация 1С. */
const IIS_PAGE_RU = `<!DOCTYPE html>
<html><head><title>Подробные данные об ошибке IIS 10.0 — 500.0 — Internal Server Error</title>
<style type="text/css">body{margin:0;font-size:.7em;}</style></head>
<body><div id="content"><div class="content-container"><h3>Ошибка HTTP 500.0 — Internal Server Error</h3>
<h4>Невозможно отобразить эту страницу ввиду того, что произошла внутренняя ошибка сервера.</h4></div>
<div class="content-container"><fieldset><h2>Подробные сведения об ошибке:</h2>
<div id="details-left"><table border="0" cellpadding="0" cellspacing="0">
<tr class="alt"><th>Модуль</th><td>nbsp;&nbsp;&nbsp;IsapiModule</td></tr>
<tr><th>Уведомление</th><td>&nbsp;&nbsp;&nbsp;ExecuteRequestHandler</td></tr>
<tr class="alt"><th>Обработчик</th><td>&nbsp;&nbsp;&nbsp;1C Web-service Extension</td></tr>
<tr><th>Код ошибки</th><td>&nbsp;&nbsp;&nbsp;0x80004005</td></tr>
</table></div>
<div id="details-right"><table border="0" cellpadding="0" cellspacing="0">
<tr class="alt"><th>Запрошенный URL-адрес</th><td>&nbsp;&nbsp;&nbsp;http://192.168.88.103:80/tracker/hs/mcp/health</td></tr>
<tr><th>Физический путь</th><td>&nbsp;&nbsp;&nbsp;C:\\inetpub\\wwwroot\\tracker\\hs\\mcp\\health</td></tr>
<tr class="alt"><th>Метод входа</th><td>&nbsp;&nbsp;&nbsp;Анонимная</td></tr>
</table></div></fieldset></div></div></body></html>`;

/** Та же страница IIS в английской локали. */
const IIS_PAGE_EN = IIS_PAGE_RU.replace("Модуль", "Module")
  .replace("Уведомление", "Notification")
  .replace("Обработчик", "Handler")
  .replace("Код ошибки", "Error Code")
  .replace("Запрошенный URL-адрес", "Requested URL")
  .replace("Физический путь", "Physical Path")
  .replace("Метод входа", "Logon Method");

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

describe("OneCClient — подробности HTTP-ошибок", () => {
  async function healthError(r: MockResponse): Promise<OneCHttpError> {
    responder = () => r;
    const client = new OneCClient(baseUrl, "a", "b");
    try {
      await client.checkHealth();
    } catch (e) {
      expect(e).toBeInstanceOf(OneCHttpError);
      return e as OneCHttpError;
    } finally {
      await client.close();
    }
    throw new Error("checkHealth не бросил исключение");
  }

  it("страница IIS: в сообщении модуль, обработчик и код ошибки, без путей и адресов", async () => {
    const err = await healthError({ status: 500, raw: IIS_PAGE_RU, contentType: "text/html" });
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe("HTTP 500: IsapiModule / 1C Web-service Extension / 0x80004005");
    expect(err.message).not.toMatch(/inetpub|192\.168/);
  });

  it("страница IIS: полные подробности (путь, URL) доступны в detail для лога", async () => {
    const err = await healthError({ status: 500, raw: IIS_PAGE_RU, contentType: "text/html" });
    expect(err.detail).toContain("C:\\inetpub\\wwwroot\\tracker\\hs\\mcp\\health");
    expect(err.detail).toContain("http://192.168.88.103:80/tracker/hs/mcp/health");
  });

  it("страница IIS в английской локали разбирается так же", async () => {
    const err = await healthError({ status: 500, raw: IIS_PAGE_EN, contentType: "text/html" });
    expect(err.message).toBe("HTTP 500: IsapiModule / 1C Web-service Extension / 0x80004005");
  });

  it("текстовое тело ошибки 1С попадает в сообщение", async () => {
    const err = await healthError({
      status: 500,
      raw: "Информационная база заблокирована\r\nдля обновления",
      contentType: "text/plain; charset=utf-8",
    });
    expect(err.message).toBe("HTTP 500: Информационная база заблокирована для обновления");
  });

  it("JSON-тело: берётся error.message", async () => {
    const err = await healthError({
      status: 502,
      json: { error: { code: -1, message: "upstream down" } },
    });
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe("HTTP 502: upstream down");
  });

  it("пустое тело: остаётся прежний короткий текст", async () => {
    const err = await healthError({ status: 500, raw: "", contentType: "text/plain" });
    expect(err.message).toBe("HTTP 500");
  });

  it("HTML без полей IIS: берётся заголовок страницы", async () => {
    const err = await healthError({
      status: 503,
      raw: "<html><head><title>Service Unavailable</title></head><body><p>try later</p></body></html>",
      contentType: "text/html",
    });
    expect(err.message).toBe("HTTP 503: Service Unavailable");
  });

  it("длинное тело обрезается в сообщении, но не теряется в detail", async () => {
    const err = await healthError({
      status: 500,
      raw: "x".repeat(10_000),
      contentType: "text/plain",
    });
    expect(err.message.length).toBeLessThanOrEqual(400);
    expect(err.detail?.length).toBeGreaterThan(err.message.length);
  });

  it("401 тоже типизирован: statusCode доступен без разбора текста", async () => {
    const err = await healthError({ status: 401, raw: "", contentType: "text/plain" });
    expect(err.statusCode).toBe(401);
  });

  it("callRpc при HTTP 500 даёт ту же подробную ошибку", async () => {
    responder = () => ({ status: 500, raw: IIS_PAGE_RU, contentType: "text/html" });
    const client = new OneCClient(baseUrl, "a", "b");
    await expect(client.callRpc("tools/list")).rejects.toMatchObject({
      statusCode: 500,
      message: "HTTP 500: IsapiModule / 1C Web-service Extension / 0x80004005",
    });
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

describe("OneCClient — подсказки к ошибкам", () => {
  async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error("ожидалось исключение");
  }

  async function healthError(r: MockResponse): Promise<OneCHttpError> {
    responder = () => r;
    const client = new OneCClient(baseUrl, "a", "b");
    try {
      return (await catchError(() => client.checkHealth())) as OneCHttpError;
    } finally {
      await client.close();
    }
  }

  it("500 от IsapiModule: подсказка про публикацию базы на веб-сервере", async () => {
    const err = await healthError({ status: 500, raw: IIS_PAGE_RU, contentType: "text/html" });
    expect(err.hint).toMatch(/необходимо опубликовать на веб-сервере/);
    expect(err.hint).toMatch(/wsisapi\.dll/);
  });

  it("formatOneCError склеивает текст ошибки и подсказку", async () => {
    const err = await healthError({ status: 500, raw: IIS_PAGE_RU, contentType: "text/html" });
    const text = formatOneCError(err);
    expect(text).toContain("HTTP 500: IsapiModule / 1C Web-service Extension / 0x80004005");
    expect(text).toContain(err.hint);
  });

  it("404: подсказка про MCP_ONEC_URL, MCP_ONEC_SERVICE_ROOT и HTTP-сервис", async () => {
    const err = await healthError({ status: 404, raw: "", contentType: "text/plain" });
    expect(err.hint).toMatch(/MCP_ONEC_URL/);
    expect(err.hint).toMatch(/MCP_ONEC_SERVICE_ROOT/);
  });

  it("502/503/504: подсказка про веб-сервер или прокси перед 1С", async () => {
    for (const status of [502, 503, 504]) {
      const err = await healthError({ status, raw: "", contentType: "text/plain" });
      expect(err.hint, `status ${status}`).toMatch(/веб-сервер/);
    }
  });

  it("500 не от IIS: подсказка про журнал регистрации 1С", async () => {
    const err = await healthError({
      status: 500,
      raw: "Ошибка в модуле HTTP-сервиса",
      contentType: "text/plain",
    });
    expect(err.hint).toMatch(/журнале регистрации/);
  });

  it("401 — это отказ в доступе, а не сбой: подсказки нет", async () => {
    const err = await healthError({ status: 401, raw: "", contentType: "text/plain" });
    expect(err.hint).toBeUndefined();
  });

  it("отказ в соединении: типизированная ошибка с кодом и подсказкой, без адреса в message", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const client = new OneCClient(`http://127.0.0.1:${port}`, "a", "b");
    const err = (await catchError(() => client.checkHealth())) as OneCConnectionError;
    await client.close();

    expect(err).toBeInstanceOf(OneCConnectionError);
    expect(err.code).toBe("ECONNREFUSED");
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.message).not.toContain("127.0.0.1");
    expect(err.hint).toMatch(/MCP_ONEC_URL/);
  });

  it("сервер не отвечает вовремя: ошибка с кодом таймаута и подсказкой про сеть", async () => {
    const silent = createServer(() => {
      // соединение принято, ответа нет
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;

    const client = new OneCClient(`http://127.0.0.1:${port}`, "a", "b", "mcp", 150);
    const err = (await catchError(() => client.checkHealth())) as OneCConnectionError;
    await client.close();
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));

    expect(err).toBeInstanceOf(OneCConnectionError);
    expect(err.code).toMatch(/TIMEOUT/);
    expect(err.hint).toMatch(/не отвечает/);
  });

  it("formatOneCError для чужих ошибок возвращает стек как раньше", () => {
    const e = new Error("boom");
    expect(formatOneCError(e)).toBe(e.stack);
  });
});
