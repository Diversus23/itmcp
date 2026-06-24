/**
 * Простой логгер с уровнями, выводящий в stderr (чтобы не мешать stdio MCP).
 */

const LEVELS = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let currentLevel: LogLevel = "INFO";

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase() as LogLevel;
  if (upper in LEVELS) {
    currentLevel = upper;
  }
}

/**
 * Форматирует ошибку с сохранением stack trace.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

function log(level: LogLevel, module: string, message: string): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} - ${module} - ${level} - ${message}\n`);
}

export function createLogger(module: string) {
  return {
    debug: (msg: string) => log("DEBUG", module, msg),
    info: (msg: string) => log("INFO", module, msg),
    warning: (msg: string) => log("WARNING", module, msg),
    error: (msg: string, err?: unknown) => {
      if (err !== undefined) {
        log("ERROR", module, `${msg}: ${formatError(err)}`);
      } else {
        log("ERROR", module, msg);
      }
    },
  };
}
