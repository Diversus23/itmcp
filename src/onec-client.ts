/**
 * Клиент для взаимодействия с HTTP-сервисом 1С.
 */

import { Agent, type Dispatcher } from "undici";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createLogger } from "./logger.js";

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

    return this.agent.request({
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
  }

  async checkHealth(): Promise<boolean> {
    logger.debug(`Запрос состояния здоровья: ${this.serviceBaseUrl}/health`);

    const response = await this.request(this.healthPath);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}`);
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
      throw new Error(`HTTP ${response.statusCode}`);
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
   */
  async downloadFile(
    fileRefId: string,
    destPath?: string,
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

    let outputPath: string;
    if (destPath) {
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
