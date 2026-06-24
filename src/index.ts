/**
 * Точка входа для запуска MCP-прокси сервера.
 */

import { main } from "./main.js";

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
