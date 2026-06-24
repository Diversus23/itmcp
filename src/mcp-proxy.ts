/**
 * MCP-прокси сервер, проксирующий запросы в 1С.
 *
 * Использует McpServer (highlevel, не deprecated) с доступом к lowlevel .server
 * для динамической регистрации обработчиков — необходимо для прокси-паттерна,
 * где tools/resources/prompts определяются 1С, а не статически.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { OneCClient } from "./onec-client.js";
import type { Config } from "./config.js";
import { createLogger, formatError } from "./logger.js";

const logger = createLogger("mcp-proxy");

/**
 * Предварительная загрузка instructions из 1С.
 * Общая для stdio и http режимов.
 */
export async function prefetchInstructions(config: Config): Promise<string | undefined> {
  if (!config.onecUsername) return undefined;

  try {
    const client = new OneCClient(
      config.onecUrl,
      config.onecUsername,
      config.onecPassword,
      config.onecServiceRoot,
      config.onecTimeout
    );
    try {
      const initResult = await client.initialize();
      logger.debug("Instructions получены из 1С");
      return initResult.instructions as string | undefined;
    } finally {
      await client.close();
    }
  } catch (e) {
    logger.warning(`Не удалось получить instructions из 1С: ${e}`);
    return undefined;
  }
}

export interface MCPProxyOptions {
  config: Config;
  username: string;
  password: string;
  instructions?: string;
  onInstructionsFetched?: (instructions: string) => void;
}

/**
 * Создает экземпляр McpServer с прокси-обработчиками,
 * маршрутизирующими все запросы в 1С.
 *
 * Выполняет health check при создании - бросает исключение, если 1С недоступна.
 */
export async function createMCPProxyServer(options: MCPProxyOptions): Promise<McpServer> {
  const { config, username, password, instructions, onInstructionsFetched } = options;

  // Создаем клиент 1С для этого сервера (per-session)
  const client = new OneCClient(
    config.onecUrl,
    username,
    password,
    config.onecServiceRoot,
    config.onecTimeout
  );

  // Проверяем подключение к 1С при создании сессии
  await client.checkHealth();

  // Если instructions не загружены при старте (OAuth2), получаем через сессионный клиент
  let resolvedInstructions = instructions;
  if (!resolvedInstructions) {
    try {
      const initResult = await client.initialize();
      resolvedInstructions = initResult.instructions as string | undefined;
      if (resolvedInstructions) {
        logger.debug("Instructions получены через сессионный клиент");
        onInstructionsFetched?.(resolvedInstructions);
      }
    } catch (e) {
      logger.warning(`Не удалось получить instructions: ${e}`);
    }
  }

  const mcpServer = new McpServer(
    { name: config.serverName, version: config.serverVersion },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      },
      instructions: resolvedInstructions,
    }
  );

  // Lowlevel Server для регистрации динамических обработчиков
  const server = mcpServer.server;

  logger.debug(
    `Создан MCP-прокси, URL: ${config.onecUrl}`
  );

  // Закрытие клиента при закрытии сервера
  server.onclose = async () => {
    await client.close();
  };

  // --- Tools ---

  // Определение локального инструмента save_file (выполняется в proxy, не в 1С)
  const saveFileTool = {
    name: "save_file",
    description:
      "Download file to local disk. Returns local file path. " +
      "Use for: binary files (PDF, DOCX, ZIP, images), large text files, " +
      "or any file you need to process locally. " +
      "File is streamed directly from 1C server, bypassing JSON-RPC size limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: {
          type: "string",
          description:
            "File ref_id (any attached file reference, e.g. ref_attached-files-of-tasks_*, ref_files_*, ref_project-reviews-attached-files_*, ref_comments-attached-files_*, ref_knowledge-base-attached-files_*)",
        },
        path: {
          type: "string",
          description: "Destination file path (optional, defaults to temp directory)",
        },
      },
      required: ["file_id"],
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor as string | undefined;
    const { tools, nextCursor } = await client.listTools(cursor);
    tools.push(saveFileTool);
    logger.debug(`Получено инструментов: ${tools.length}`);
    return { tools, nextCursor };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      // save_file выполняется локально в proxy (скачивание файла на диск)
      if (name === "save_file") {
        const fileId = (args as Record<string, unknown>)?.file_id as string;
        const destPath = (args as Record<string, unknown>)?.path as string | undefined;

        if (!fileId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "file_id is required" }) }],
            isError: true,
          };
        }

        logger.debug(`save_file: скачивание ${fileId}`);
        const result = await client.downloadFile(fileId, destPath);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: false,
        };
      }

      logger.debug(`Вызов инструмента: ${name}`);
      const result = await client.callTool(name, args ?? {});

      if (result.isError) {
        logger.error(`Ошибка выполнения инструмента ${name}`);
      }

      return { content: result.content, isError: result.isError };
    } catch (e) {
      logger.error(`Ошибка при вызове инструмента ${name}`, e);
      return {
        content: [
          { type: "text" as const, text: `Ошибка выполнения инструмента: ${formatError(e)}` },
        ],
        isError: true,
      };
    }
  });

  // --- Resources ---

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor as string | undefined;
    const { resources, nextCursor } = await client.listResources(cursor);
    logger.debug(`Получено ресурсов: ${resources.length}`);
    return { resources, nextCursor };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = String(request.params.uri);
    try {
      logger.debug(`Чтение ресурса: ${uri}`);
      const contents = await client.readResource(uri);
      return { contents };
    } catch (e) {
      logger.error(`Ошибка при чтении ресурса ${uri}`, e);
      return {
        contents: [
          { uri, mimeType: "text/plain", text: `Ошибка чтения ресурса: ${formatError(e)}` },
        ],
      };
    }
  });

  // --- Prompts ---

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const cursor = request.params?.cursor as string | undefined;
    const { prompts, nextCursor } = await client.listPrompts(cursor);
    logger.debug(`Получено промптов: ${prompts.length}`);
    return { prompts, nextCursor };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      logger.debug(`Получение промпта: ${name}`);
      const result = await client.getPrompt(name, args ?? {});
      return result;
    } catch (e) {
      logger.error(`Ошибка при получении промпта ${name}`, e);
      return { description: `Ошибка получения промпта: ${formatError(e)}`, messages: [] };
    }
  });

  return mcpServer;
}
