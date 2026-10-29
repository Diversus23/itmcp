/**
 * Клиент для взаимодействия с HTTP-сервисом 1С.
 */

import { Agent, type Dispatcher } from "undici";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createLogger, formatError } from "./logger.js";

const logger = createLogger("onec-client");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown; // прозрачное проксирование (annotations и др.)
}

interface Resource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

interface Prompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  [key: string]: unknown;
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface PromptMessage {
  role: string;
  content: { type: string; text: string };
}

/** Сколько байт тела ошибочного ответа читаем (страница IIS — около 7 КБ). */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Длина текста ошибки в message: он уходит клиенту и на страницу входа. */
const MAX_SUMMARY_LENGTH = 300;
/** Длина полных подробностей для лога. */
const MAX_DETAIL_LENGTH = 2000;

/**
 * Сбой обращения к 1С.
 *
 * message — короткая сводка без внутренних адресов и путей, её безопасно
 * показывать пользователю. hint — вероятная причина и что проверить.
 * detail — полные подробности только для лога.
 */
export class OneCRequestError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OneCRequestError";
  }
}

/** Ответ 1С (или веб-сервера перед ней) с кодом, отличным от 2xx. */
export class OneCHttpError extends OneCRequestError {
  constructor(
    readonly statusCode: number,
    message: string,
    hint?: string,
    detail?: string,
  ) {
    super(message, hint, detail);
    this.name = "OneCHttpError";
  }
}

/** Не удалось дозвониться до 1С: отказ в соединении, DNS, таймаут. */
export class OneCConnectionError extends OneCRequestError {
  constructor(
    readonly code: string,
    message: string,
    hint?: string,
    detail?: string,
  ) {
    super(message, hint, detail);
    this.name = "OneCConnectionError";
  }
}

/**
 * Текст ошибки для пользователя: сводка и подсказка. Для чужих ошибок —
 * как раньше, со стеком.
 */
export function formatOneCError(err: unknown): string {
  if (err instanceof OneCRequestError) {
    return err.hint ? `${err.message}. ${err.hint}` : err.message;
  }
  return formatError(err);
}

function hintForHttpStatus(status: number, iisModule: string | undefined): string | undefined {
  if (status >= 500 && iisModule === "IsapiModule") {
    return (
      "Вероятно, информационную базу 1С необходимо опубликовать на веб-сервере " +
      "(или переопубликовать, если публикация повреждена). Проверьте также, что сервер 1С " +
      "запущен, а версия wsisapi.dll соответствует платформе."
    );
  }
  if (status === 404) {
    return (
      "HTTP-сервис не найден. Проверьте MCP_ONEC_URL (имя публикации базы), " +
      "MCP_ONEC_SERVICE_ROOT и что в конфигурации опубликован HTTP-сервис MCP."
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return (
      "Веб-сервер или прокси перед 1С не получил ответ. Проверьте, что веб-сервер " +
      "и сервер 1С запущены."
    );
  }
  if (status >= 500) {
    return "1С вернула внутреннюю ошибку. Подробности — в журнале регистрации 1С и в логе прокси.";
  }
  return undefined;
}

function hintForConnectionCode(code: string): string {
  switch (code) {
    case "ECONNREFUSED":
      return (
        "Соединение отклонено. Проверьте MCP_ONEC_URL и что веб-сервер 1С запущен и " +
        "слушает указанный порт."
      );
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return (
        "Имя сервера не найдено. Проверьте адрес в MCP_ONEC_URL (из Docker-контейнера " +
        "localhost указывает на сам контейнер, а не на хост)."
      );
    default:
      if (/TIMEOUT|TIMEDOUT|UNREACH/.test(code)) {
        return (
          "Сервер 1С не отвечает. Проверьте сетевой доступ, брандмауэр и значение " +
          "MCP_ONEC_URL."
        );
      }
      return "Соединение с 1С не удалось. Проверьте MCP_ONEC_URL и сетевой доступ к серверу 1С.";
  }
}

/** Код сетевой ошибки undici/Node (ECONNREFUSED, UND_ERR_*), если это она. */
function networkErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code =
    (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code) ? code : undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function htmlToText(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      // IIS в первой ячейке таблицы теряет амперсанд («nbsp;»), поэтому & необязателен
      .replace(/&?nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, "&"),
  );
}

// Блок «Подробные сведения об ошибке» страницы IIS (русская и английская локали)
const IIS_ERROR_RE =
  /(?:Модуль|Module)\s+(\S+)\s+(?:Уведомление|Notification)\s+\S+\s+(?:Обработчик|Handler)\s+(.+?)\s+(?:Код ошибки|Error Code)\s+(\S+)/;
const IIS_URL_RE = /(?:Запрошенный URL-адрес|Requested URL)\s+(\S+)/;
const IIS_PATH_RE =
  /(?:Физический путь|Physical Path)\s+(.+?)(?=\s+(?:Метод входа|Logon Method)|$)/;

/**
 * Разбирает тело ошибочного ответа в короткую сводку (для message) и
 * полные подробности (для лога). Тело может быть страницей IIS, JSON или
 * простым текстом.
 */
function describeErrorBody(
  contentType: string,
  rawBody: string,
): { summary: string; detail: string; iisModule?: string } {
  const body = rawBody.trim();
  if (!body) return { summary: "", detail: "" };

  if (/json/i.test(contentType) || body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      const nested = (parsed.error as { message?: unknown } | undefined)?.message;
      const text = [nested, parsed.error, parsed.message].find((v) => typeof v === "string");
      if (typeof text === "string" && text.trim()) {
        return { summary: truncate(collapseWhitespace(text), MAX_SUMMARY_LENGTH), detail: body };
      }
    } catch {
      // не JSON — разбираем как текст ниже
    }
  }

  if (/html/i.test(contentType) || /^<(!doctype|html)/i.test(body)) {
    const text = htmlToText(body);
    const iis = IIS_ERROR_RE.exec(text);
    if (iis) {
      const summary = `${iis[1]} / ${iis[2]} / ${iis[3]}`;
      const url = IIS_URL_RE.exec(text)?.[1];
      const path = IIS_PATH_RE.exec(text)?.[1];
      const extra = [url && `URL: ${url}`, path && `путь: ${path}`].filter(Boolean);
      return { summary, detail: [summary, ...extra].join("; "), iisModule: iis[1] };
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    const summary = collapseWhitespace(title ? htmlToText(title) : text);
    return {
      summary: truncate(summary, MAX_SUMMARY_LENGTH),
      detail: truncate(text, MAX_DETAIL_LENGTH),
    };
  }

  const text = collapseWhitespace(body);
  return {
    summary: truncate(text, MAX_SUMMARY_LENGTH),
    detail: truncate(text, MAX_DETAIL_LENGTH),
  };
}

async function readBodyCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Выход из for await закрывает поток, остаток тела не скачивается
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
    size += chunk.length;
    if (size >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

export class OneCClient {
  private readonly serviceBaseUrl: string;
  private readonly authHeader: string;
  private readonly agent: Agent;
  private readonly originUrl: string;
  private readonly rpcPath: string;
  private readonly healthPath: string;
  private readonly timeout: number;
  private rpcIdCounter = 0;
  private closed = false;

  constructor(
    baseUrl: string,
    username: string,
    password: string,
    serviceRoot: string = "mcp",
    timeout: number = 120_000,
  ) {
    this.serviceBaseUrl = OneCClient.buildServiceUrl(baseUrl, serviceRoot);
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    this.timeout = timeout;

    // Кешируем разобранные URL для повторного использования
    const rpcParsed = new URL(`${this.serviceBaseUrl}/rpc`);
    const healthParsed = new URL(`${this.serviceBaseUrl}/health`);
    this.originUrl = rpcParsed.origin;
    this.rpcPath = rpcParsed.pathname + rpcParsed.search;
    this.healthPath = healthParsed.pathname + healthParsed.search;

    // Connection pool
    this.agent = new Agent({
      connections: 20,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });

    logger.debug(`Базовый URL HTTP-сервиса: ${this.serviceBaseUrl}`);
  }

  static buildServiceUrl(baseUrl: string, serviceRoot: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/hs/${serviceRoot.replace(/^\/+|\/+$/g, "")}`;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("OneCClient уже закрыт");
    }
  }

  private async request(
    path: string,
    options: { method?: string; body?: string } = {},
  ): Promise<Dispatcher.ResponseData> {
    this.ensureOpen();

    try {
      return await this.agent.request({
        origin: this.originUrl,
        path,
        method: options.method ?? "GET",
        headers: {
          authorization: this.authHeader,
          "content-type": "application/json",
        },
        body: options.body,
        headersTimeout: this.timeout,
        bodyTimeout: this.timeout,
      });
    } catch (e) {
      const code = networkErrorCode(e);
      if (!code) throw e;
      // Адрес сервера — во внутренние подробности, наружу только код ошибки
      const detail = `${this.originUrl}${path}: ${e instanceof Error ? e.message : String(e)}`;
      logger.warning(`Нет связи с 1С [${detail}]`);
      throw new OneCConnectionError(
        code,
        `Нет связи с 1С (${code})`,
        hintForConnectionCode(code),
        detail,
      );
    }
  }

  /**
   * Строит ошибку по не-2xx ответу, прочитав тело: без него причину сбоя
   * (например, страницу IIS с кодом 0x80004005) не увидеть.
   */
  private async toHttpError(response: Dispatcher.ResponseData): Promise<OneCHttpError> {
    const status = response.statusCode;
    let rawBody = "";
    try {
      rawBody = await readBodyCapped(response.body, MAX_ERROR_BODY_BYTES);
    } catch {
      // тело недоступно — остаётся только код статуса
    }

    const contentType = String(response.headers["content-type"] ?? "");
    const { summary, detail, iisModule } = describeErrorBody(contentType, rawBody);
    const message = summary ? `HTTP ${status}: ${summary}` : `HTTP ${status}`;

    // 4xx — штатные отказы (логируются вызывающим кодом); 5xx — сбой на стороне 1С
    if (status >= 500) {
      logger.warning(`1С ответила ${message}${detail ? ` [${detail}]` : ""}`);
    }
    return new OneCHttpError(
      status,
      message,
      hintForHttpStatus(status, iisModule),
      detail || undefined,
    );
  }

  async checkHealth(): Promise<boolean> {
    logger.debug(`Запрос состояния здоровья: ${this.serviceBaseUrl}/health`);

    const response = await this.request(this.healthPath);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw await this.toHttpError(response);
    }

    const text = await response.body.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (json.status === "ok") {
      logger.debug("Сервис 1С доступен и здоров (статус OK).");
      return true;
    }

    throw new Error(`1C service reported not healthy: ${JSON.stringify(json)}`);
  }

  private nextRpcId(): number {
    return ++this.rpcIdCounter;
  }

  async callRpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextRpcId(),
      method,
      params,
    };

    logger.debug(`JSON-RPC запрос: ${method}`);

    const response = await this.request(this.rpcPath, {
      method: "POST",
      body: JSON.stringify(rpcRequest),
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw await this.toHttpError(response);
    }

    const text = await response.body.text();

    let rpcResponse: JsonRpcResponse;
    try {
      rpcResponse = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error(`Невалидный JSON-ответ от 1С (${text.slice(0, 200)})`);
    }

    if (rpcResponse.error) {
      throw new Error(`JSON-RPC ошибка ${rpcResponse.error.code}: ${rpcResponse.error.message}`);
    }

    return rpcResponse.result ?? {};
  }

  async initialize(clientInfo?: {
    name: string;
    version: string;
  }): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (clientInfo) {
      params.clientInfo = clientInfo;
    }
    return this.callRpc("initialize", params);
  }

  async listTools(cursor?: string): Promise<{ tools: Tool[]; nextCursor?: string }> {
    const params: Record<string, unknown> = {};
    if (cursor) params.cursor = cursor;

    const result = await this.callRpc("tools/list", params);
    const toolsData = (result.tools as Tool[]) ?? [];

    return {
      tools: toolsData.map((t) => ({
        ...t,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? {},
      })),
      nextCursor: result.nextCursor as string | undefined,
    };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentItem[]; isError: boolean }> {
    const result = await this.callRpc("tools/call", {
      name,
      arguments: args,
    });

    const content: ContentItem[] = [];
    if (Array.isArray(result.content)) {
      for (const item of result.content as ContentItem[]) {
        if (item.type === "text") {
          content.push({ type: "text", text: item.text ?? "" });
        } else if (item.type === "image") {
          content.push({
            type: "image",
            data: item.data ?? "",
            mimeType: item.mimeType ?? "image/png",
          });
        } else {
          logger.warning(`Неизвестный тип контента: ${item.type}, обрабатываем как текст`);
          content.push({ type: "text", text: item.text ?? JSON.stringify(item) });
        }
      }
    }

    return { content, isError: (result.isError as boolean) ?? false };
  }

  async listResources(cursor?: string): Promise<{ resources: Resource[]; nextCursor?: string }> {
    const params: Record<string, unknown> = {};
    if (cursor) params.cursor = cursor;

    const result = await this.callRpc("resources/list", params);
    const resourcesData = (result.resources as Resource[]) ?? [];

    return {
      resources: resourcesData.map((r) => ({
        ...r,
        name: r.name ?? "",
        description: r.description ?? "",
      })),
      nextCursor: result.nextCursor as string | undefined,
    };
  }

  async readResource(uri: string): Promise<ResourceContent[]> {
    const result = await this.callRpc("resources/read", { uri });

    const contents: ResourceContent[] = [];
    if (Array.isArray(result.contents)) {
      for (const item of result.contents as ResourceContent[]) {
        if (item.text !== undefined) {
          contents.push({
            uri: item.uri ?? uri,
            mimeType: item.mimeType ?? "text/plain",
            text: item.text,
          });
        } else if (item.blob !== undefined) {
          contents.push({
            uri: item.uri ?? uri,
            mimeType: item.mimeType ?? "application/octet-stream",
            blob: item.blob,
          });
        } else {
          contents.push({
            uri: item.uri ?? uri,
            mimeType: "text/plain",
            text: `Unknown resource content format: ${JSON.stringify(item)}`,
          });
        }
      }
    } else {
      contents.push({
        uri,
        mimeType: "application/json",
        text: JSON.stringify(result),
      });
    }

    return contents;
  }

  async listPrompts(cursor?: string): Promise<{ prompts: Prompt[]; nextCursor?: string }> {
    const params: Record<string, unknown> = {};
    if (cursor) params.cursor = cursor;

    const result = await this.callRpc("prompts/list", params);
    const promptsData = (result.prompts as Prompt[]) ?? [];

    return {
      prompts: promptsData.map((p) => ({
        ...p,
        description: p.description ?? "",
        arguments: (p.arguments ?? []).map((a) => ({
          ...a,
          description: a.description ?? "",
          required: a.required ?? false,
        })),
      })),
      nextCursor: result.nextCursor as string | undefined,
    };
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
  ): Promise<{ description: string; messages: PromptMessage[] }> {
    const result = await this.callRpc("prompts/get", {
      name,
      arguments: args,
    });

    const messages: PromptMessage[] = [];
    if (Array.isArray(result.messages)) {
      for (const msg of result.messages as Array<Record<string, unknown>>) {
        const msgContent = msg.content as Record<string, unknown> | undefined;
        messages.push({
          role: (msg.role as string) ?? "user",
          content: {
            type: "text",
            text: (msgContent?.text as string) ?? "",
          },
        });
      }
    }

    return {
      description: (result.description as string) ?? "",
      messages,
    };
  }

  /**
   * Скачать файл из 1С через бинарный endpoint MCP HTTP-сервиса.
   * Файл стримится напрямую на диск, минуя JSON-RPC и base64.
   *
   * При заданном allowedDir запись ограничена этим каталогом: destPath
   * (в том числе относительный) разрешается относительно него, а выход
   * за его пределы отвергается. Без allowedDir destPath используется
   * как есть (доверенный локальный запуск).
   */
  async downloadFile(
    fileRefId: string,
    destPath?: string,
    allowedDir?: string,
  ): Promise<{ path: string; size: number; mimeType: string; filename: string }> {
    this.ensureOpen();

    const filePath = `${this.rpcPath.replace(/\/rpc$/, "")}/files/${encodeURIComponent(fileRefId)}`;

    logger.debug(`Скачивание файла: ${fileRefId}`);

    const response = await this.agent.request({
      origin: this.originUrl,
      path: filePath,
      method: "GET",
      headers: {
        authorization: this.authHeader,
      },
      headersTimeout: this.timeout,
      bodyTimeout: this.timeout,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const text = await response.body.text();
      throw new Error(`Download failed: HTTP ${response.statusCode} - ${text}`);
    }

    const contentDisposition = response.headers["content-disposition"] as string | undefined;
    const mimeType = (response.headers["content-type"] as string) ?? "application/octet-stream";
    const contentLength = parseInt((response.headers["content-length"] as string) ?? "0", 10);

    let filename = fileRefId;
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="([^"]+)"/);
      if (match?.[1]) {
        filename = match[1];
      }
    }
    // Санитизация: только базовое имя — Content-Disposition приходит извне
    // и не должен управлять каталогом записи (path traversal)
    filename = basename(filename.replace(/\\/g, "/"));
    if (!filename || filename === "." || filename === "..") {
      filename = fileRefId;
    }

    let outputPath: string;
    if (allowedDir) {
      const dir = resolve(allowedDir);
      outputPath = destPath ? resolve(dir, destPath) : join(dir, filename);
      const rel = relative(dir, outputPath);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `Destination path is outside of the allowed directory: ${destPath ?? filename}`,
        );
      }
      await mkdir(dirname(outputPath), { recursive: true });
    } else if (destPath) {
      outputPath = destPath;
    } else {
      const tempDir = join(tmpdir(), "mcp-files");
      await mkdir(tempDir, { recursive: true });
      outputPath = join(tempDir, filename);
    }

    const fileStream = createWriteStream(outputPath);
    await pipeline(Readable.from(response.body), fileStream);

    const size = contentLength || fileStream.bytesWritten;

    logger.debug(`Файл сохранен: ${outputPath} (${size} bytes)`);

    return { path: outputPath, size, mimeType, filename };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.agent.close();
    logger.debug("Соединение с 1С закрыто");
  }
}
