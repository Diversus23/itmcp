/**
 * HTTP-сервер с поддержкой Streamable HTTP и OAuth2 для MCP.
 *
 * Транспорт: StreamableHTTPServerTransport из @modelcontextprotocol/sdk v1.
 * При миграции на SDK v2 заменить на NodeStreamableHTTPServerTransport
 * из @modelcontextprotocol/node (см. docs/migration.md в SDK).
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMCPProxyServer, prefetchInstructions } from "./mcp-proxy.js";
import { OneCClient } from "./onec-client.js";
import { AuthRateLimiter, OAuth2Service, OAuth2Store } from "./auth/index.js";
import type { Config } from "./config.js";
import { createLogger, formatError } from "./logger.js";

const logger = createLogger("http-server");

// --- Константы ---

const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // максимальный интервал проверки TTL

const OAUTH2_SNAPSHOT_INTERVAL_MS = 30_000; // периодическая запись OAuth2-снапшота

const CRED_CACHE_TTL_MS = 10_000; // успешный health-check / auth-failure
const CRED_CACHE_CONNECTION_ERROR_TTL_MS = 2_000; // короткий TTL для сетевых ошибок
const CRED_CACHE_MAX_SIZE = 1024; // жёсткий лимит на число записей в кэше

// --- Типы ---

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  /** Открытые HTTP-ответы (SSE-стримы и длинные POST); пока > 0 — сессия активна. */
  activeStreams: number;
}

/**
 * Расширение Express Request: bearer-middleware прикрепляет креденшилы
 * 1С к запросу для последующего использования в /mcp обработчике.
 */
declare module "express-serve-static-core" {
  interface Request {
    onecLogin?: string;
    onecPassword?: string;
  }
}

// --- Утилиты ---

function getPublicUrl(config: Config, req: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const proto = req.protocol;
  const host = req.get("host") ?? `${config.host}:${config.port}`;
  return `${proto}://${host}`;
}

/**
 * Результат валидации креденшилов.
 */
interface CredentialValidationResult {
  valid: boolean;
  error?: "auth" | "connection";
  details?: string;
}

/**
 * Валидация креденшилов через health-check 1С (используя OneCClient).
 *
 * Различает ошибку авторизации (HTTP 401/403) от ошибки подключения
 * (таймаут, DNS, сеть), чтобы не вводить пользователя в заблуждение.
 */
async function validateOneCCredentials(
  config: Config,
  username: string,
  password: string,
): Promise<CredentialValidationResult> {
  const client = new OneCClient(
    config.onecUrl,
    username,
    password,
    config.onecServiceRoot,
    config.onecTimeout,
  );
  try {
    await client.checkHealth();
    return { valid: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // HTTP 401/403 — ошибка авторизации
    if (/HTTP\s+(401|403)/i.test(msg)) {
      logger.warning(`Ошибка авторизации 1С для пользователя ${username}: ${msg}`);
      return { valid: false, error: "auth", details: msg };
    }

    // Всё остальное — проблема подключения
    logger.error(`Ошибка подключения к 1С при валидации: ${msg}`);
    return { valid: false, error: "connection", details: msg };
  } finally {
    await client.close();
  }
}

/**
 * Создает функцию валидации с кэшем результатов на уровне процесса.
 * Снижает шторм health-check'ов при параллельных OAuth-запросах от
 * клиента и при ретраях после кратковременной недоступности 1С.
 *
 * Ключ кэша = HMAC-SHA256(login + ":" + password) с разовой солью на время
 * жизни процесса — пароль в чистом виде в мапе не хранится и не может быть
 * восстановлен из ключа даже при дампе памяти. Это идентификатор кэша, а не
 * хранилище паролей: KDF здесь не нужен (и убил бы смысл кэша).
 *
 * Лимит размера: lazy cleanup протухших записей + жёсткий FIFO-кап.
 * Map в JavaScript сохраняет порядок вставки, так что при превышении
 * лимита удаляются самые старые ключи (даже если ещё не истекли).
 */
function createCachedValidator(config: Config) {
  const cache = new Map<string, { result: CredentialValidationResult; exp: number }>();
  // Соль живёт только в памяти процесса и не персистится.
  const keySalt = randomBytes(32);

  return async (username: string, password: string): Promise<CredentialValidationResult> => {
    const key = createHmac("sha256", keySalt).update(`${username}:${password}`).digest("hex");
    const now = Date.now();
    const cached = cache.get(key);

    if (cached && cached.exp > now) {
      // Поднимаем запись в конец Map (LRU-семантика для FIFO-cap)
      cache.delete(key);
      cache.set(key, cached);
      return cached.result;
    }

    const result = await validateOneCCredentials(config, username, password);

    // Connection-ошибки кэшируем на короткий промежуток, чтобы не плодить
    // запросы к недоступной 1С. Auth-ошибки и успех — на полный TTL.
    const ttl =
      result.error === "connection" ? CRED_CACHE_CONNECTION_ERROR_TTL_MS : CRED_CACHE_TTL_MS;
    cache.set(key, { result, exp: now + ttl });

    // Lazy cleanup протухших записей
    for (const [k, v] of cache) {
      if (v.exp <= now) cache.delete(k);
    }

    // Жёсткий FIFO-cap: если после очистки записей всё равно слишком
    // много — удаляем самые старые
    while (cache.size > CRED_CACHE_MAX_SIZE) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }

    return result;
  };
}

// --- HTML-страницы (login / errors) ---

/**
 * HTML-экранирование пользовательского текста.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Базовая палитра (синхронизирована с web/task/style.css и web/shared/markdown-content.css).
 */
const PAGE_STYLES = `
  :root {
    --accent: #08a652;
    --accent-hover: #067341;
    --accent-bg: #ebfee8;
    --text: #212529;
    --text-muted: #6c757d;
    --border: #dee2e6;
    --surface: #ffffff;
    --surface-alt: #f8f9fa;
    --danger-bg: #f8d7da;
    --danger-text: #721c24;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background: var(--surface-alt);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%;
    max-width: 400px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 32px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
  .card--wide { max-width: 520px; }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    color: var(--accent);
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.3px;
  }
  .brand-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
  }
  .subtitle {
    margin: 0 0 24px;
    color: var(--text-muted);
    font-size: 14px;
  }
  form { display: flex; flex-direction: column; gap: 14px; }
  label {
    display: block;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  input {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-bg);
  }
  button {
    margin-top: 8px;
    padding: 11px 16px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  .footer {
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }
  .alert {
    padding: 12px 14px;
    border-radius: 6px;
    font-size: 14px;
    background: var(--danger-bg);
    color: var(--danger-text);
    margin-bottom: 16px;
  }
  pre {
    background: var(--surface-alt);
    border: 1px solid var(--border);
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--text);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .back-link {
    display: inline-block;
    margin-top: 16px;
    color: var(--accent);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
  }
  .back-link:hover { color: var(--accent-hover); text-decoration: underline; }
`.trim();

function renderLoginPage(qs: string, config: Config): string {
  const serverName = escapeHtml(config.serverName);
  const serverVersion = escapeHtml(config.serverVersion);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Вход в 1С — ${serverName}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="brand-dot"></span>1C MCP</div>
    <h1>Вход в 1С</h1>
    <p class="subtitle">Укажите учетные данные пользователя 1С</p>
    <form method="post" action="/authorize?${qs}" autocomplete="on">
      <div>
        <label for="username">Логин</label>
        <input type="text" id="username" name="username" required autofocus autocomplete="username">
      </div>
      <div>
        <label for="password">Пароль</label>
        <input type="password" id="password" name="password" autocomplete="current-password">
      </div>
      <button type="submit">Войти</button>
    </form>
    <div class="footer">${serverName} · v${serverVersion}</div>
  </main>
</body>
</html>`;
}

function renderErrorPage(title: string, message: string, config: Config, details?: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetails = details ? escapeHtml(details) : "";
  const serverName = escapeHtml(config.serverName);
  const serverVersion = escapeHtml(config.serverVersion);
  const detailsBlock = safeDetails ? `<pre>${safeDetails}</pre>` : "";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} — ${serverName}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <main class="card card--wide">
    <div class="brand"><span class="brand-dot"></span>1C MCP</div>
    <h1>${safeTitle}</h1>
    <div class="alert">${safeMessage}</div>
    ${detailsBlock}
    <a class="back-link" href="javascript:history.back()">&#8592; Вернуться назад</a>
    <div class="footer">${serverName} · v${serverVersion}</div>
  </main>
</body>
</html>`;
}

// --- Bearer-токен middleware ---

function createBearerMiddleware(config: Config, oauth2Service: OAuth2Service | null) {
  const protectedPaths = ["/mcp"];

  return (req: Request, res: Response, next: NextFunction): void => {
    if (config.authMode !== "oauth2") {
      next();
      return;
    }

    const isProtected = protectedPaths.some((p) => req.path.startsWith(p));
    if (!isProtected) {
      next();
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer error="invalid_token"')
        .json({ error: "invalid_token" });
      return;
    }

    const token = authHeader.slice(7);
    const creds = oauth2Service?.validateAccessToken(token);

    if (!creds) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer error="invalid_token"')
        .json({ error: "invalid_token" });
      return;
    }

    // Прикрепляем креденшилы к запросу (типизировано через declare module)
    req.onecLogin = creds.login;
    req.onecPassword = creds.password;
    next();
  };
}

// --- Основной HTTP-сервер ---

/**
 * Экземпляр приложения: express app + освобождение ресурсов (таймеры,
 * сессии, снапшот OAuth2). Выделен из runHttpServer для тестируемости.
 */
export interface HttpAppHandle {
  app: express.Express;
  dispose: () => Promise<void>;
}

export async function createHttpApp(config: Config): Promise<HttpAppHandle> {
  // Состояние сервера — инкапсулировано в функции
  const sessions = new Map<string, SessionEntry>();

  /**
   * Регистрирует HTTP-ответ как активность сессии на всё время его жизни.
   * Пока ответ открыт (SSE-стрим, длинный tool call) — сессия не истекает;
   * при закрытии активность обновляется, и TTL отсчитывается заново.
   */
  function trackResponse(entry: SessionEntry, res: Response): void {
    entry.lastActivity = Date.now();
    entry.activeStreams++;
    res.once("close", () => {
      entry.activeStreams--;
      entry.lastActivity = Date.now();
    });
  }

  /** Ответ в формате JSON-RPC, совпадающий с ошибками SDK-транспорта. */
  function jsonRpcError(res: Response, status: number, code: number, message: string): void {
    res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
  }

  // Интервал проверки TTL: не реже четверти TTL (важно для коротких TTL),
  // но не чаще предела в 60 сек
  const sweepIntervalMs = Math.min(
    SESSION_CLEANUP_INTERVAL_MS,
    Math.max(Math.floor(config.sessionTtlMs / 4), 20),
  );
  const sessionCleanupTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of sessions) {
      if (entry.activeStreams > 0) {
        // Живой SSE-стрим или незавершённый запрос — сессия активна
        entry.lastActivity = now;
        continue;
      }
      if (now - entry.lastActivity > config.sessionTtlMs) {
        entry.transport.close().catch(() => {});
        sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Очищено устаревших сессий: ${cleaned}`);
    }
  }, sweepIntervalMs);

  const app = express();

  // За reverse proxy req.ip должен браться из X-Forwarded-For, иначе
  // rate limiting по IP будет видеть только адрес прокси
  if (config.trustProxy !== undefined) {
    app.set("trust proxy", config.trustProxy);
  }

  // Защита от DNS rebinding: браузер жертвы может обратиться к локальному
  // серверу через домен атакующего — тогда Host не совпадёт с белым списком
  if (config.allowedHosts.length > 0) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const rawHost = req.headers.host ?? "";
      let hostname = rawHost;
      try {
        hostname = new URL(`http://${rawHost}`).hostname;
      } catch {
        // некорректный Host не совпадёт ни с одним разрешённым
      }
      if (!config.allowedHosts.includes(hostname)) {
        res.status(403).json({
          error: "forbidden",
          error_description: "Host header is not in the allowed list",
        });
        return;
      }
      next();
    });
  }

  // Request-логирование: успешные запросы на DEBUG, ошибки на WARNING —
  // чтобы инциденты (404 Session not found и т.п.) были видны в логах.
  // finish — обычное завершение ответа, close — обрыв соединения (SSE);
  // на keep-alive сокетах close может прийти с большой задержкой
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    let logged = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      const sid = req.headers["mcp-session-id"];
      const line =
        `${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms ` +
        `ip=${req.ip ?? "-"}${sid ? ` session=${String(sid)}` : ""}`;
      if (res.statusCode >= 400) {
        logger.warning(line);
      } else {
        logger.debug(line);
      }
    };
    res.once("finish", logRequest);
    res.once("close", logRequest);
    next();
  });

  // Большой лимит тела — только для /mcp (крупные tool calls). Остальным
  // эндпоинтам (OAuth-ручки и пр.) хватает 100kb: иначе неавторизованный
  // клиент мог бы исчерпывать память 50-мегабайтными телами на /token
  app.use("/mcp", express.json({ limit: "50mb" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true, limit: "100kb" }));

  // CORS — корректная обработка credentials + origin
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origins = config.corsOrigins;

    if (origins.includes("*")) {
      res.set("Access-Control-Allow-Origin", "*");
    } else {
      const requestOrigin = req.get("origin");
      if (requestOrigin && origins.includes(requestOrigin)) {
        res.set("Access-Control-Allow-Origin", requestOrigin);
        res.set("Access-Control-Allow-Credentials", "true");
        res.set("Vary", "Origin");
      }
      // Чужой или отсутствующий origin — CORS-заголовки не выставляются
    }

    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.set("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  // OAuth2
  let oauth2Store: OAuth2Store | null = null;
  let oauth2Service: OAuth2Service | null = null;
  let authRateLimiter: AuthRateLimiter | null = null;
  if (config.authMode === "oauth2") {
    oauth2Store = new OAuth2Store({
      persistencePath: config.oauth2StorePath,
      graceWindowMs: config.oauth2RefreshGraceMs,
      // В лояльном режиме использованные refresh-токены храним, пока жив
      // выданный при ротации access-токен: опоздавшая параллельная сессия
      // (другое окно Claude Code с тем же файлом креденшилов) идемпотентно
      // догоняется до актуальной пары вместо принудительной реавторизации.
      // В строгом режиме — только grace-окно, дальше reuse = отзыв семьи.
      consumedRetentionMs: config.oauth2RevokeOnReuse
        ? config.oauth2RefreshGraceMs
        : Math.max(config.oauth2RefreshGraceMs, config.oauth2AccessTtl * 1000),
    });

    // Восстанавливаем сохраненные токены до старта приема запросов —
    // иначе первый запрос с валидным Bearer ушел бы в 401, пока snapshot
    // не загружен.
    await oauth2Store.loadSnapshot();

    oauth2Service = new OAuth2Service(
      oauth2Store,
      config.oauth2CodeTtl,
      config.oauth2AccessTtl,
      config.oauth2RefreshTtl,
      { revokeFamilyOnReuse: config.oauth2RevokeOnReuse },
    );
    oauth2Store.startCleanupTask(60_000);
    if (config.oauth2StorePath) {
      oauth2Store.startSnapshotTask(OAUTH2_SNAPSHOT_INTERVAL_MS);
      logger.info(`OAuth2 авторизация включена; снапшот: ${config.oauth2StorePath}`);
      // Проба записи сразу при старте: если каталог снапшота недоступен
      // (типично в Docker — bind-mount каталог, созданный root'ом, при
      // процессе под пользователем node), молчаливый warning раз в 30 сек
      // легко пропустить, а каждый рестарт будет разлогинивать всех клиентов.
      try {
        await oauth2Store.saveSnapshot();
      } catch (e) {
        logger.error(
          `OAuth2-снапшот НЕ записывается (${formatError(e)}). ` +
            `Токены не переживут перезапуск — все клиенты будут вынуждены переавторизоваться. ` +
            `Проверьте права на каталог: в Docker выполните chown -R 1000:1000 на каталог тома ` +
            `(${config.oauth2StorePath}).`,
        );
      }
    } else {
      logger.info("OAuth2 авторизация включена; персистентность отключена (in-memory)");
    }

    // Защита от перебора паролей на /authorize и /token
    if (config.authRateLimitMaxAttempts > 0) {
      authRateLimiter = new AuthRateLimiter({
        maxAttempts: config.authRateLimitMaxAttempts,
        windowMs: config.authRateLimitWindowMs,
        baseBlockMs: config.authRateLimitBlockMs,
      });
      authRateLimiter.startCleanupTask();
      logger.info(
        `Rate limiting авторизации включен: ${config.authRateLimitMaxAttempts} попыток / ${Math.round(config.authRateLimitWindowMs / 1000)}с, блокировка от ${Math.round(config.authRateLimitBlockMs / 1000)}с${config.authRateLimitByIp ? "" : "; учёт по IP отключен"}`,
      );
    } else {
      logger.warning("Rate limiting авторизации ОТКЛЮЧЕН (MCP_AUTH_RATE_LIMIT_MAX_ATTEMPTS=0)");
    }
  }

  // Кэширующий валидатор — используется во всех OAuth-хендлерах
  const validateCreds = createCachedValidator(config);

  // Bearer middleware
  app.use(createBearerMiddleware(config, oauth2Service));

  // Pre-fetch instructions при старте (если есть статические креденшилы)
  let cachedInstructions = await prefetchInstructions(config);

  // --- Определяем креды для per-session MCP ---

  function getSessionCredentials(req: Request): {
    username: string;
    password: string;
  } {
    if (config.authMode === "oauth2") {
      return {
        username: req.onecLogin ?? "",
        password: req.onecPassword ?? "",
      };
    }
    return {
      username: config.onecUsername ?? "",
      password: config.onecPassword,
    };
  }

  // =============================================
  // Streamable HTTP транспорт на /mcp
  // =============================================

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Существующая сессия
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      trackResponse(existing, res);
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    // Новая сессия: initialize без session id (спецификация) или с
    // устаревшим session id — лояльное восстановление после рестарта
    // сервера или истечения TTL, чтобы клиент не застревал на ошибке
    if (isInitializeRequest(req.body)) {
      const creds = getSessionCredentials(req);

      // Health check через кэширующий валидатор (TTL 10 сек): рой
      // переинициализаций после рестарта прокси не превращается в шторм
      // health-check'ов к 1С
      const check = await validateCreds(creds.username, creds.password);
      if (!check.valid) {
        if (check.error === "auth") {
          // Креденшилы перестали приниматься 1С (пароль сменили) —
          // клиент должен пройти авторизацию заново
          res
            .status(401)
            .set("WWW-Authenticate", 'Bearer error="invalid_token"')
            .json({ error: "invalid_token" });
          return;
        }
        logger.error(`Не удалось создать MCP-сессию (1С недоступна): ${check.details ?? ""}`);
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: `1C service unavailable: ${check.details ?? ""}` },
          id: null,
        });
        return;
      }

      let server: McpServer;
      try {
        server = await createMCPProxyServer({
          config,
          username: creds.username,
          password: creds.password,
          instructions: cachedInstructions,
          onInstructionsFetched: (instr) => {
            cachedInstructions = instr;
          },
          skipHealthCheck: true,
          // Запись файлов save_file в HTTP-режиме — только в белый каталог
          saveFileAllowedDir: config.saveFileDir ?? join(tmpdir(), "mcp-files"),
        });
      } catch (e) {
        logger.error("Не удалось создать MCP-сессию (1С недоступна)", e);
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: `1C service unavailable: ${formatError(e)}` },
          id: null,
        });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          // Кап на количество сессий: вытесняем самые старые неактивные,
          // чтобы initialize-шторм не исчерпал память
          while (sessions.size >= config.maxSessions) {
            let oldest: [string, SessionEntry] | undefined;
            for (const candidate of sessions) {
              if (candidate[1].activeStreams > 0) continue;
              if (!oldest || candidate[1].lastActivity < oldest[1].lastActivity) {
                oldest = candidate;
              }
            }
            if (!oldest) break; // все сессии с живыми стримами — не рвём их
            oldest[1].transport.close().catch(() => {});
            sessions.delete(oldest[0]);
            logger.debug(`Сессия ${oldest[0]} вытеснена по лимиту maxSessions`);
          }
          sessions.set(id, { transport, server, lastActivity: Date.now(), activeStreams: 0 });
          logger.debug(`Streamable HTTP сессия создана: ${id}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.debug(`Streamable HTTP сессия закрыта: ${transport.sessionId}`);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      // Неизвестная/истёкшая сессия: 404 по спецификации MCP — клиент
      // обязан прозрачно начать новую сессию через InitializeRequest
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }

    jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    trackResponse(entry, res);
    await entry.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !entry) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    await entry.transport.close();
    sessions.delete(sessionId);
    res.status(200).end();
  });

  // =============================================
  // Основные маршруты
  // =============================================

  app.get("/", (_req: Request, res: Response) => {
    const endpoints: Record<string, unknown> = {
      info: "/info",
      health: "/health",
      streamable_http: "/mcp",
    };
    if (config.authMode === "oauth2") {
      endpoints.oauth2 = {
        well_known_prm: "/.well-known/oauth-protected-resource",
        well_known_as: "/.well-known/oauth-authorization-server",
        register: "/register",
        authorize: "/authorize",
        token: "/token",
      };
    }
    res.json({ name: config.serverName, version: config.serverVersion, endpoints });
  });

  app.get("/info", (_req: Request, res: Response) => {
    res.json({
      name: config.serverName,
      version: config.serverVersion,
      description: "MCP-прокси для взаимодействия с 1С",
      endpoints: {
        streamable_http: "/mcp",
        health: "/health",
        info: "/info",
      },
      transports: {
        streamable_http: { endpoint: "/mcp" },
      },
    });
  });

  app.get("/health", async (_req: Request, res: Response) => {
    const result: Record<string, unknown> = {
      name: config.serverName,
      version: config.serverVersion,
      auth: { mode: config.authMode },
      active_sessions: sessions.size,
    };

    if (config.authMode === "none" && config.onecUsername) {
      const credResult = await validateCreds(config.onecUsername, config.onecPassword);
      if (credResult.valid) {
        result.status = "healthy";
        result.onec_connection = "ok";
      } else if (credResult.error === "auth") {
        result.status = "unhealthy";
        result.onec_connection = "auth_failed";
      } else {
        result.status = "unhealthy";
        result.onec_connection = "error";
      }
    } else {
      result.status = "healthy";
      result.onec_connection = "not_checked";
    }

    const statusCode = result.status === "unhealthy" ? 503 : 200;
    res.status(statusCode).json(result);
  });

  // =============================================
  // OAuth2 маршруты
  // =============================================

  if (config.authMode === "oauth2" && oauth2Service) {
    const svc = oauth2Service;
    const limiter = authRateLimiter;

    /** Ключи rate-limit: по логину 1С и (если не отключено) по IP клиента. */
    const rateLimitKeys = (req: Request, username: unknown): string[] => {
      const keys = [`login:${typeof username === "string" ? username : ""}`];
      if (config.authRateLimitByIp) {
        keys.push(`ip:${req.ip ?? "unknown"}`);
      }
      return keys;
    };

    app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
      res.json(svc.generatePrmDocument(getPublicUrl(config, req)));
    });

    app.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
      const baseUrl = getPublicUrl(config, req);
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        grant_types_supported: ["authorization_code", "refresh_token", "password"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp"],
      });
    });

    app.post("/register", (req: Request, res: Response) => {
      const body = req.body ?? {};
      const baseUrl = getPublicUrl(config, req);

      const clientData: Record<string, unknown> = {
        client_id: "mcp-public-client",
        client_secret: "",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        grant_types: ["authorization_code", "refresh_token", "password"],
        response_types: ["code"],
        redirect_uris: [
          `${baseUrl}/callback`,
          "http://localhost/callback",
          "http://127.0.0.1/callback",
        ],
        token_endpoint_auth_method: "none",
        application_type: "web",
      };

      if (Array.isArray(body.redirect_uris)) {
        const uris = clientData.redirect_uris as string[];
        for (const uri of body.redirect_uris) {
          if (!uris.includes(uri)) uris.push(uri);
        }
      }

      logger.info("Client registration: вернули фиксированный client_id='mcp-public-client'");
      res.json(clientData);
    });

    app.get("/authorize", (req: Request, res: Response) => {
      const {
        response_type,
        client_id,
        redirect_uri,
        state,
        code_challenge,
        code_challenge_method,
      } = req.query as Record<string, string>;

      if (
        !response_type ||
        !client_id ||
        !redirect_uri ||
        !code_challenge ||
        !code_challenge_method
      ) {
        res
          .status(400)
          .send(renderErrorPage("Ошибка", "Отсутствуют обязательные параметры OAuth2", config));
        return;
      }
      if (response_type !== "code") {
        res
          .status(400)
          .send(renderErrorPage("Ошибка", "Поддерживается только response_type=code", config));
        return;
      }
      if (code_challenge_method !== "S256") {
        res
          .status(400)
          .send(
            renderErrorPage("Ошибка", "Поддерживается только code_challenge_method=S256", config),
          );
        return;
      }

      const qs = new URLSearchParams({
        redirect_uri,
        state: state ?? "",
        code_challenge,
      }).toString();

      res.type("html").send(renderLoginPage(qs, config));
    });

    app.post("/authorize", async (req: Request, res: Response) => {
      const { username, password } = req.body;
      const { redirect_uri, state, code_challenge } = req.query as Record<string, string>;

      if (!redirect_uri || !code_challenge) {
        res
          .status(400)
          .send(renderErrorPage("Ошибка", "Отсутствуют обязательные параметры", config));
        return;
      }

      const rlKeys = rateLimitKeys(req, username ?? "");
      const rl = limiter?.check(rlKeys);
      if (rl && !rl.allowed) {
        const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
        res
          .status(429)
          .set("Retry-After", String(retryAfterSec))
          .send(
            renderErrorPage(
              "Слишком много попыток",
              `Превышен лимит неудачных попыток входа. Повторите через ${retryAfterSec} сек.`,
              config,
            ),
          );
        return;
      }

      const result = await validateCreds(username, password ?? "");
      if (!result.valid) {
        if (result.error === "auth") {
          limiter?.recordFailure(rlKeys);
        }
        if (result.error === "connection") {
          res
            .status(503)
            .send(
              renderErrorPage(
                "Ошибка подключения к 1С",
                "Не удалось подключиться к серверу 1С",
                config,
                result.details ?? undefined,
              ),
            );
        } else {
          res
            .status(401)
            .send(renderErrorPage("Ошибка авторизации", "Неверный логин или пароль 1С", config));
        }
        return;
      }

      limiter?.recordSuccess(rlKeys);

      const code = svc.generateAuthorizationCode(
        username,
        password ?? "",
        redirect_uri,
        code_challenge,
      );

      const params = new URLSearchParams({ code });
      if (state) params.set("state", state);

      const redirectUrl = `${redirect_uri}?${params.toString()}`;
      logger.info(
        `Authorization code выдан для пользователя ${username}, redirect: ${redirect_uri}`,
      );
      res.redirect(302, redirectUrl);
    });

    app.post("/token", async (req: Request, res: Response) => {
      const { grant_type, code, redirect_uri, code_verifier, refresh_token, username, password } =
        req.body;

      // Password Grant
      if (grant_type === "password") {
        if (!username) {
          res.status(400).json({
            error: "invalid_request",
            error_description: "Missing username",
          });
          return;
        }

        const rlKeys = rateLimitKeys(req, username);
        const rl = limiter?.check(rlKeys);
        if (rl && !rl.allowed) {
          const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
          res
            .status(429)
            .set("Retry-After", String(retryAfterSec))
            .json({
              error: "rate_limited",
              error_description: `Too many failed login attempts, retry after ${retryAfterSec}s`,
            });
          return;
        }

        const credResult = await validateCreds(username, password ?? "");
        if (!credResult.valid) {
          if (credResult.error === "connection") {
            res.status(503).json({
              error: "server_error",
              error_description: `Unable to connect to 1C: ${credResult.details ?? "unknown error"}`,
            });
          } else {
            limiter?.recordFailure(rlKeys);
            res.status(400).json({
              error: "invalid_grant",
              error_description: "Invalid username or password",
            });
          }
          return;
        }

        limiter?.recordSuccess(rlKeys);

        const result = svc.generateTokensFromCredentials(username, password ?? "");

        logger.info(`Password grant выдан для пользователя ${username}`);
        res.json({
          access_token: result.accessToken,
          token_type: result.tokenType,
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: "mcp",
        });
        return;
      }

      // Authorization Code Grant
      if (grant_type === "authorization_code") {
        if (!code || !redirect_uri || !code_verifier) {
          res.status(400).json({
            error: "invalid_request",
            error_description: "Missing required parameters",
          });
          return;
        }

        const result = svc.exchangeCodeForTokens(code, redirect_uri, code_verifier);
        if (!result) {
          res.status(400).json({
            error: "invalid_grant",
            error_description: "Invalid or expired authorization code",
          });
          return;
        }

        res.json({
          access_token: result.accessToken,
          token_type: result.tokenType,
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: "mcp",
        });
        return;
      }

      // Refresh Token
      if (grant_type === "refresh_token") {
        if (!refresh_token) {
          res.status(400).json({
            error: "invalid_request",
            error_description: "Missing refresh_token",
          });
          return;
        }

        const result = svc.refreshTokens(refresh_token);
        if (result.kind !== "ok") {
          // replay (использование после grace-окна) и invalid (нет токена /
          // истек) одинаково возвращают invalid_grant — клиент в обоих
          // случаях должен заново пройти авторизацию. Отличие только в
          // логе и том, что для replay вся семья токенов уже отозвана
          // в OAuth2Service.refreshTokens.
          res.status(400).json({
            error: "invalid_grant",
            error_description:
              result.kind === "replay"
                ? "Refresh token reuse detected; token family revoked"
                : "Invalid or expired refresh token",
          });
          return;
        }

        res.json({
          access_token: result.tokens.accessToken,
          token_type: result.tokens.tokenType,
          expires_in: result.tokens.expiresIn,
          refresh_token: result.tokens.refreshToken,
          scope: "mcp",
        });
        return;
      }

      res.status(400).json({
        error: "unsupported_grant_type",
        error_description: `Grant type '${grant_type}' not supported`,
      });
    });
  }

  // --- 404 и error handler в формате OAuth2 ---
  // MCP SDK 1.29 при discovery строго валидирует тела ошибок по OAuth-схеме
  // ({error, error_description}). Любой 404 без этих полей ломает клиента.

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "not_found",
      error_description: `Endpoint ${req.method} ${req.path} not found`,
    });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Unhandled error: ${formatError(err)}`);
    if (res.headersSent) return;
    // body-parser и прочие middleware выставляют статус ошибки
    // (например, 413 Payload Too Large) — не подменяем его на 500
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({
      error: status === 413 ? "payload_too_large" : "server_error",
      error_description: err.message || "Internal server error",
    });
  });

  // --- Освобождение ресурсов (graceful shutdown / тесты) ---

  const dispose = async (): Promise<void> => {
    clearInterval(sessionCleanupTimer);
    authRateLimiter?.stopCleanupTask();
    if (oauth2Store) {
      oauth2Store.stopCleanupTask();
      oauth2Store.stopSnapshotTask();
      // Финальный снапшот, чтобы перезапуск не сбросил клиентов на /authorize
      try {
        await oauth2Store.saveSnapshot();
      } catch (e) {
        logger.warning(`Не удалось сохранить финальный OAuth2-снапшот: ${formatError(e)}`);
      }
    }

    // Закрываем все транспорты сессий параллельно
    await Promise.allSettled(
      Array.from(sessions.values()).map((entry) => entry.transport.close().catch(() => {})),
    );
    sessions.clear();
  };

  return { app, dispose };
}

export async function runHttpServer(config: Config): Promise<void> {
  const { app, dispose } = await createHttpApp(config);

  const httpServer = createServer(app);
  httpServer.listen(config.port, config.host, () => {
    logger.info(`HTTP-сервер запущен на ${config.host}:${config.port}`);
  });

  // Graceful shutdown — ожидаем завершения активных сессий
  const shutdown = async () => {
    logger.info("Остановка HTTP-сервера...");
    await dispose();
    // Закрываем HTTP-сервер (перестаем принимать новые соединения)
    httpServer.close();
    // Рвём keep-alive и SSE-соединения: иначе close() будет ждать их
    // закрытия бесконечно и процесс зависнет до kill-таймаута
    httpServer.closeAllConnections();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Ждем завершения
  await new Promise<void>((resolve) => {
    httpServer.on("close", resolve);
  });
}
