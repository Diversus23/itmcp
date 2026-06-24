/**
 * OAuth2 хранилище и сервис для авторизации.
 *
 * Особенности реализации:
 *   - Refresh-токены ротируются с grace-window: повторное использование одного
 *     и того же refresh_token в течение нескольких секунд возвращает уже
 *     выпущенные токены (идемпотентно), а после окна — отзывает всю цепочку
 *     (RFC 6819 §5.2.2.3, OAuth 2.1 §6.1).
 *   - Опциональная персистентность access/refresh-токенов в JSON-файл,
 *     чтобы перезапуск процесса (docker compose, краш) не выкидывал клиентов
 *     на повторную авторизацию.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../logger.js";

const logger = createLogger("oauth2");

// --- Константы ---

const DEFAULT_GRACE_WINDOW_MS = 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

/** Ограниченный доступ к снапшоту (rw только владельцу). На Windows игнорируется. */
const SNAPSHOT_FILE_MODE = 0o600;

/** Параметры повторной попытки rename — нужны на Windows, где файл может быть
 *  кратковременно заблокирован антивирусом/индексатором. */
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_DELAY_MS = 100;

// --- Data types ---

interface AuthCodeData {
  login: string;
  password: string;
  redirectUri: string;
  codeChallenge: string;
  exp: number;
}

interface AccessTokenData {
  login: string;
  password: string;
  exp: number;
  family: string;
}

interface RefreshTokenData {
  login: string;
  password: string;
  exp: number;
  family: string;
  rotationCounter: number;
  consumedAt?: number;
  replacementAccessToken?: string;
  replacementRefreshToken?: string;
}

interface IssuedTokens {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
}

interface SnapshotPayload {
  version: 1;
  savedAt: number;
  accessTokens: Array<[string, AccessTokenData]>;
  refreshTokens: Array<[string, RefreshTokenData]>;
}

/** Результат атомарной попытки ротации refresh-токена. */
export type RefreshClaim =
  | { kind: "missing" }
  | {
      kind: "consumed-replay-grace";
      login: string;
      family: string;
      replacementAccessToken: string;
      replacementRefreshToken: string;
      sinceConsumedMs: number;
    }
  | {
      kind: "consumed-replay-stale";
      login: string;
      family: string;
    }
  | {
      kind: "rotated";
      login: string;
      family: string;
      rotationCounter: number;
    };

// --- Store ---

export interface OAuth2StoreOptions {
  /** Окно идемпотентности при повторном использовании refresh-токена (мс). */
  graceWindowMs?: number;
  /** Путь к JSON-снапшоту для персистентности. Если не задан — только память. */
  persistencePath?: string;
}

export class OAuth2Store {
  private authCodes = new Map<string, AuthCodeData>();
  private accessTokens = new Map<string, AccessTokenData>();
  private refreshTokens = new Map<string, RefreshTokenData>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotInFlight: Promise<void> | null = null;
  private dirty = false;

  readonly graceWindowMs: number;
  readonly persistencePath: string | undefined;

  constructor(options: OAuth2StoreOptions = {}) {
    this.graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.persistencePath = options.persistencePath;
  }

  // --- Background tasks ---

  startCleanupTask(intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS): void {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), intervalMs);
    logger.debug(
      `Запущена задача очистки OAuth2 токенов (интервал: ${intervalMs}ms)`
    );
  }

  stopCleanupTask(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.debug("Задача очистки OAuth2 токенов остановлена");
    }
  }

  startSnapshotTask(intervalMs: number = DEFAULT_SNAPSHOT_INTERVAL_MS): void {
    if (!this.persistencePath) return;
    this.snapshotTimer = setInterval(() => {
      if (this.dirty) {
        this.saveSnapshot().catch((e) => {
          logger.warning(`Не удалось сохранить OAuth2-снапшот: ${e}`);
        });
      }
    }, intervalMs);
    logger.debug(
      `Запущена периодическая запись OAuth2-снапшота (интервал: ${intervalMs}ms)`
    );
  }

  stopSnapshotTask(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let codes = 0, access = 0, refresh = 0;

    for (const [key, data] of this.authCodes) {
      if (data.exp < now) { this.authCodes.delete(key); codes++; }
    }
    for (const [key, data] of this.accessTokens) {
      if (data.exp < now) { this.accessTokens.delete(key); access++; }
    }
    for (const [key, data] of this.refreshTokens) {
      // Удаляем когда И сам токен истёк, И grace-окно после consume закрылось
      const consumedExpired =
        data.consumedAt !== undefined &&
        now - data.consumedAt > this.graceWindowMs;
      if (data.exp < now || consumedExpired) {
        this.refreshTokens.delete(key);
        refresh++;
      }
    }

    if (codes || access || refresh) {
      logger.debug(
        `Очищено токенов: codes=${codes}, access=${access}, refresh=${refresh}`
      );
      if (access || refresh) this.dirty = true;
    }
  }

  // --- Auth codes (одноразовые, не персистятся) ---

  saveAuthCode(code: string, data: AuthCodeData): void {
    this.authCodes.set(code, data);
    logger.debug(`Сохранен authorization code для ${data.login}`);
  }

  getAuthCode(code: string): AuthCodeData | undefined {
    const data = this.authCodes.get(code);
    this.authCodes.delete(code); // одноразовый
    if (data && data.exp < Date.now()) {
      logger.debug(`Authorization code истек: ${code}`);
      return undefined;
    }
    return data;
  }

  // --- Access tokens ---

  saveAccessToken(token: string, data: AccessTokenData): void {
    this.accessTokens.set(token, data);
    this.dirty = true;
    logger.debug(`Сохранен access token для ${data.login}`);
  }

  getAccessToken(token: string): AccessTokenData | undefined {
    const data = this.accessTokens.get(token);
    if (data && data.exp < Date.now()) {
      logger.debug(`Access token истек`);
      this.accessTokens.delete(token);
      this.dirty = true;
      return undefined;
    }
    return data;
  }

  // --- Refresh tokens ---

  saveRefreshToken(token: string, data: RefreshTokenData): void {
    this.refreshTokens.set(token, data);
    this.dirty = true;
    logger.debug(
      `Сохранен refresh token для ${data.login} (family=${data.family})`
    );
  }

  /**
   * Атомарная попытка ротации refresh-токена.
   *
   * Метод выполняется синхронно — между чтением и пометкой токена
   * как consumed нет ни одного `await`, поэтому два параллельных HTTP-
   * запроса с одним и тем же refresh_token гарантированно увидят разные
   * результаты: первый получит `rotated`, второй — `consumed-replay-grace`
   * с теми же replacement-токенами.
   *
   * Возвращает discriminated union с указанием, что делать вызывающему:
   *   - `missing`: токена нет / истёк
   *   - `consumed-replay-grace`: использован недавно — отдать те же replacements
   *   - `consumed-replay-stale`: использован давно — отозвать семью
   *   - `rotated`: успешно ротирован, новые токены уже сохранены в Store
   */
  claimRefreshForRotation(
    token: string,
    newAccessToken: string,
    newRefreshToken: string,
    accessTtlMs: number,
    refreshTtlMs: number
  ): RefreshClaim {
    const data = this.refreshTokens.get(token);
    const now = Date.now();

    if (!data) return { kind: "missing" };

    if (data.exp < now) {
      this.refreshTokens.delete(token);
      this.dirty = true;
      return { kind: "missing" };
    }

    if (data.consumedAt !== undefined) {
      const sinceConsumed = now - data.consumedAt;
      if (
        sinceConsumed <= this.graceWindowMs &&
        data.replacementAccessToken &&
        data.replacementRefreshToken
      ) {
        return {
          kind: "consumed-replay-grace",
          login: data.login,
          family: data.family,
          replacementAccessToken: data.replacementAccessToken,
          replacementRefreshToken: data.replacementRefreshToken,
          sinceConsumedMs: sinceConsumed,
        };
      }
      return {
        kind: "consumed-replay-stale",
        login: data.login,
        family: data.family,
      };
    }

    // Свежий — атомарно фиксируем ротацию: создаём новые записи и помечаем
    // старый как consumed с указанием replacements ДО того, как кто-либо
    // ещё сможет дочитать из карты (Node.js однопоточный, синхронный код
    // атомарен относительно других async-задач).
    this.accessTokens.set(newAccessToken, {
      login: data.login,
      password: data.password,
      exp: now + accessTtlMs,
      family: data.family,
    });
    this.refreshTokens.set(newRefreshToken, {
      login: data.login,
      password: data.password,
      exp: now + refreshTtlMs,
      family: data.family,
      rotationCounter: data.rotationCounter + 1,
    });
    data.consumedAt = now;
    data.replacementAccessToken = newAccessToken;
    data.replacementRefreshToken = newRefreshToken;
    this.dirty = true;

    return {
      kind: "rotated",
      login: data.login,
      family: data.family,
      rotationCounter: data.rotationCounter + 1,
    };
  }

  /**
   * Отзыв всей семьи токенов (RFC 6819 §5.2.2.3). Срабатывает, когда
   * клиент пытается повторно использовать refresh-токен после grace-window —
   * это либо replay-атака, либо клиент с поломанной логикой.
   */
  revokeFamily(family: string): void {
    let revokedRefresh = 0;
    let revokedAccess = 0;
    for (const [key, data] of this.refreshTokens) {
      if (data.family === family) {
        this.refreshTokens.delete(key);
        revokedRefresh++;
      }
    }
    for (const [key, data] of this.accessTokens) {
      if (data.family === family) {
        this.accessTokens.delete(key);
        revokedAccess++;
      }
    }
    if (revokedRefresh || revokedAccess) {
      this.dirty = true;
      logger.warning(
        `Отозвана семья токенов ${family}: refresh=${revokedRefresh}, access=${revokedAccess}`
      );
    }
  }

  // --- Persistence ---

  /**
   * Атомарная запись снапшота. Пишет во временный файл и атомарно
   * переименовывает поверх целевого. На Windows rename() поверх
   * существующего файла иногда падает с EPERM/EBUSY (антивирус,
   * индексатор) — тогда повторяем несколько раз с задержкой.
   *
   * Содержит креденшилы пользователей 1С — файл создаётся с правами
   * 0o600 (на POSIX-системах). На Windows mode игнорируется, и
   * ответственность за ограничение доступа лежит на администраторе:
   * каталог должен быть на томе/в каталоге с ограниченными NTFS ACL.
   */
  async saveSnapshot(): Promise<void> {
    if (!this.persistencePath) return;
    if (this.snapshotInFlight) return this.snapshotInFlight;

    const path = this.persistencePath;
    const tmpPath = `${path}.tmp`;

    // Снимаем dirty-флаг ДО формирования payload — иначе изменения,
    // прилетевшие во время await writeFile/rename, перетрутся финальным
    // dirty=false и потеряются до следующего snapshot-tick'а.
    const wasDirty = this.dirty;
    this.dirty = false;

    this.snapshotInFlight = (async () => {
      try {
        await mkdir(dirname(path), { recursive: true });

        const payload: SnapshotPayload = {
          version: 1,
          savedAt: Date.now(),
          accessTokens: Array.from(this.accessTokens.entries()),
          refreshTokens: Array.from(this.refreshTokens.entries()),
        };

        await writeFile(tmpPath, JSON.stringify(payload), {
          encoding: "utf8",
          mode: SNAPSHOT_FILE_MODE,
        });

        await this.renameWithRetry(tmpPath, path);

        logger.debug(
          `OAuth2-снапшот сохранен: access=${payload.accessTokens.length}, refresh=${payload.refreshTokens.length}`
        );
      } catch (e) {
        // Восстанавливаем dirty, чтобы следующий tick попробовал снова
        this.dirty = wasDirty || this.dirty;
        // Прибираем за собой временный файл, чтобы при перезапуске не
        // оставалось мусора (loadSnapshot тоже умеет его удалять).
        try { await unlink(tmpPath); } catch { /* ignore */ }
        throw e;
      } finally {
        this.snapshotInFlight = null;
      }
    })();

    return this.snapshotInFlight;
  }

  /**
   * rename с повторными попытками для Windows. Антивирус/индексатор
   * могут кратковременно держать файл и вызвать EPERM/EBUSY —
   * единичный retry с паузой обычно решает проблему.
   */
  private async renameWithRetry(from: string, to: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
      try {
        await rename(from, to);
        return;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
        lastError = e;
        if (attempt < RENAME_MAX_ATTEMPTS) {
          await delay(RENAME_RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw lastError;
  }

  /**
   * Восстановление из снапшота. Молча игнорирует отсутствие файла.
   * Истекшие записи отбрасываются на лету. Если рядом обнаружен
   * остаточный *.tmp от предыдущего краша — удаляется (полу-записанный
   * tmp использовать нельзя, целевой файл считается единственным
   * валидным источником).
   */
  async loadSnapshot(): Promise<void> {
    if (!this.persistencePath) return;

    // Подчищаем мусорный *.tmp от прерванной записи
    try { await unlink(`${this.persistencePath}.tmp`); } catch { /* ignore */ }

    let raw: string;
    try {
      raw = await readFile(this.persistencePath, "utf8");
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        logger.debug("OAuth2-снапшот отсутствует — старт с пустым хранилищем");
        return;
      }
      logger.warning(`Не удалось прочитать OAuth2-снапшот: ${e}`);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      logger.warning(`OAuth2-снапшот повреждён, игнорируется: ${e}`);
      return;
    }

    // Структурная валидация — даже при правильной версии payload может быть
    // повреждён (null, не-массивы), и тогда for...of упадёт с TypeError.
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as SnapshotPayload).version !== 1 ||
      !Array.isArray((payload as SnapshotPayload).accessTokens) ||
      !Array.isArray((payload as SnapshotPayload).refreshTokens)
    ) {
      logger.warning(
        "OAuth2-снапшот имеет некорректную структуру или версию, игнорируется"
      );
      return;
    }

    const snap = payload as SnapshotPayload;
    const now = Date.now();
    let loadedAccess = 0;
    let loadedRefresh = 0;

    for (const entry of snap.accessTokens) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [token, data] = entry;
      if (!data || typeof data.exp !== "number" || data.exp < now) continue;
      this.accessTokens.set(token, data);
      loadedAccess++;
    }
    for (const entry of snap.refreshTokens) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [token, data] = entry;
      if (!data || typeof data.exp !== "number" || data.exp < now) continue;
      const consumedExpired =
        data.consumedAt !== undefined &&
        now - data.consumedAt > this.graceWindowMs;
      if (consumedExpired) continue;
      this.refreshTokens.set(token, data);
      loadedRefresh++;
    }

    logger.info(
      `OAuth2-снапшот загружен: access=${loadedAccess}, refresh=${loadedRefresh}`
    );
  }
}

// --- Service ---

/** Результат refresh-операции с указанием причины отказа. */
export type RefreshResult =
  | { kind: "ok"; tokens: IssuedTokens }
  | { kind: "invalid" }
  | { kind: "replay" };

export class OAuth2Service {
  constructor(
    private readonly store: OAuth2Store,
    private readonly codeTtl: number = 120,
    private readonly accessTtl: number = 3600,
    private readonly refreshTtl: number = 1209600
  ) {}

  generatePrmDocument(publicUrl: string): Record<string, unknown> {
    const url = publicUrl.replace(/\/+$/, "");
    return {
      resource: url,
      authorization_servers: [url],
      authorization_endpoint: `${url}/authorize`,
      token_endpoint: `${url}/token`,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
    };
  }

  generateAuthorizationCode(
    login: string,
    password: string,
    redirectUri: string,
    codeChallenge: string
  ): string {
    const code = randomBytes(32).toString("base64url");
    this.store.saveAuthCode(code, {
      login,
      password,
      redirectUri,
      codeChallenge,
      exp: Date.now() + this.codeTtl * 1000,
    });
    return code;
  }

  validatePkce(codeVerifier: string, codeChallenge: string): boolean {
    const hash = createHash("sha256").update(codeVerifier, "ascii").digest();
    const computed = hash.toString("base64url");
    return computed === codeChallenge;
  }

  /**
   * Выпуск новой пары токенов в новой "семье". Каждый authorization-code
   * grant и каждый password grant начинают новую семью — это позволяет
   * точечно отзывать скомпрометированные цепочки, не трогая другие
   * сессии того же пользователя.
   */
  private issueNewFamily(login: string, password: string): IssuedTokens {
    const family = randomUUID();
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();

    this.store.saveAccessToken(accessToken, {
      login,
      password,
      exp: now + this.accessTtl * 1000,
      family,
    });
    this.store.saveRefreshToken(refreshToken, {
      login,
      password,
      exp: now + this.refreshTtl * 1000,
      family,
      rotationCounter: 0,
    });

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: this.accessTtl,
      refreshToken,
    };
  }

  exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string
  ): IssuedTokens | undefined {
    const codeData = this.store.getAuthCode(code);
    if (!codeData) {
      logger.warning("Недействительный или истекший authorization code");
      return undefined;
    }

    if (codeData.redirectUri !== redirectUri) {
      logger.warning(
        `Несовпадение redirect_uri: ожидался ${codeData.redirectUri}, получен ${redirectUri}`
      );
      return undefined;
    }

    if (!this.validatePkce(codeVerifier, codeData.codeChallenge)) {
      logger.warning("PKCE валидация не прошла");
      return undefined;
    }

    const tokens = this.issueNewFamily(codeData.login, codeData.password);
    logger.debug(`Выданы токены для пользователя ${codeData.login}`);
    return tokens;
  }

  /**
   * Обмен refresh-токена с поддержкой grace-window.
   *
   * 1. Если токен валиден и не использован — стандартная ротация.
   * 2. Если токен использован недавно (< graceWindow) — возвращаем
   *    те же ранее выпущенные токены (идемпотентность для параллельных
   *    запросов и сетевых ретраев).
   * 3. Если токен использован давно (>= graceWindow) — отзываем всю семью
   *    и возвращаем `replay` (возможная replay-атака).
   */
  refreshTokens(refreshToken: string): RefreshResult {
    // Кандидаты на новые токены готовим заранее — claim атомарно сохранит
    // их в Store, если токен окажется свежим.
    const candidateAccess = randomBytes(32).toString("base64url");
    const candidateRefresh = randomBytes(32).toString("base64url");

    const claim = this.store.claimRefreshForRotation(
      refreshToken,
      candidateAccess,
      candidateRefresh,
      this.accessTtl * 1000,
      this.refreshTtl * 1000
    );

    if (claim.kind === "missing") {
      logger.warning("Недействительный или истекший refresh token");
      return { kind: "invalid" };
    }

    if (claim.kind === "consumed-replay-stale") {
      logger.warning(
        `Refresh token replay после grace-window для ${claim.login} — отзыв семьи ${claim.family}`
      );
      this.store.revokeFamily(claim.family);
      return { kind: "replay" };
    }

    if (claim.kind === "consumed-replay-grace") {
      // Идемпотентность: отдаем уже выпущенные ранее токены
      const accessData = this.store.getAccessToken(claim.replacementAccessToken);
      if (!accessData) {
        // Замещающий access уже истек — отзываем семью
        this.store.revokeFamily(claim.family);
        return { kind: "replay" };
      }
      const expiresIn = Math.max(
        1,
        Math.floor((accessData.exp - Date.now()) / 1000)
      );
      logger.info(
        `Refresh token использован повторно в grace-window (${claim.sinceConsumedMs}ms) — идемпотентный ответ для ${claim.login}`
      );
      return {
        kind: "ok",
        tokens: {
          accessToken: claim.replacementAccessToken,
          tokenType: "Bearer",
          expiresIn,
          refreshToken: claim.replacementRefreshToken,
        },
      };
    }

    // claim.kind === "rotated"
    logger.debug(
      `Обновлены токены для пользователя ${claim.login} (rotation #${claim.rotationCounter}, family=${claim.family})`
    );
    return {
      kind: "ok",
      tokens: {
        accessToken: candidateAccess,
        tokenType: "Bearer",
        expiresIn: this.accessTtl,
        refreshToken: candidateRefresh,
      },
    };
  }

  generateTokensFromCredentials(login: string, password: string): IssuedTokens {
    return this.issueNewFamily(login, password);
  }

  validateAccessToken(
    token: string
  ): { login: string; password: string } | undefined {
    const data = this.store.getAccessToken(token);
    if (!data) return undefined;
    return { login: data.login, password: data.password };
  }
}
