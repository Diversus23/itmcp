/**
 * Stdio сервер для MCP.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMCPProxyServer, prefetchInstructions } from "./mcp-proxy.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

const logger = createLogger("stdio-server");

export async function runStdioServer(config: Config): Promise<void> {
  logger.info("Запуск MCP сервера в режиме stdio");

  const instructions = await prefetchInstructions(config);

  const server = await createMCPProxyServer({
    config,
    username: config.onecUsername ?? "",
    password: config.onecPassword,
    instructions,
  });

  const transport = new StdioServerTransport();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Получен сигнал завершения, закрытие stdio сервера...");
    await server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    logger.debug("MCP stdio сервер подключен");
  } catch (e) {
    logger.error("Ошибка в stdio сервере", e);
    throw e;
  }
}
