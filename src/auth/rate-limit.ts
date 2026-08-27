/**
 * Ограничитель попыток авторизации (защита от перебора паролей).
 *
 * Считает неудачные попытки по произвольным ключам (IP, логин) в скользящем
 * окне. При достижении лимита ключ блокируется; повторные серии неудач
 * удваивают длительность блокировки вплоть до потолка (экспоненциальный
 * backoff). Успешная авторизация сбрасывает счётчик.
 *
 * Хранилище in-memory: Map с lazy-очисткой и жёстким FIFO-капом на число
 * записей, чтобы поток случайных логинов не раздувал память процесса.
 */

import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";

const logger = createLogger("rate-limit");

/**
 * Ключи длиннее этого порога заменяются на SHA-256-хеш, чтобы атакующий
 * не мог раздувать память процесса гигантскими «логинами» (тело запроса
 * принимается до 50mb, а логин попадает в ключ как есть).
 */
const MAX_KEY_LENGTH = 128;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 900_000; // 15 минут
const DEFAULT_BASE_BLOCK_MS = 60_000; // 1 минута
const DEFAULT_MAX_BLOCK_MS = 3_600_000; // 1 час
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export interface AuthRateLimiterOptions {
  /** Число неудачных попыток в окне до блокировки. */
  maxAttempts?: number;
  /** Окно, в котором накапливаются неудачные попытки (мс). */
  windowMs?: number;
  /** Базовая длительность первой блокировки (мс). */
  baseBlockMs?: number;
  /** Потолок длительности блокировки при эскалации (мс). */
  maxBlockMs?: number;
  /** Жёсткий лимит числа отслеживаемых ключей. */
  maxEntries?: number;
}

export type RateLimitCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

interface AttemptEntry {
  failures: number;
  windowStart: number;
  blockedUntil: number;
  /** Сколько блокировок уже было подряд — определяет эскалацию. */
  blockCount: number;
}

export class AuthRateLimiter {
  private entries = new Map<string, AttemptEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly baseBlockMs: number;
  private readonly maxBlockMs: number;
  private readonly maxEntries: number;

  constructor(options: AuthRateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.baseBlockMs = options.baseBlockMs ?? DEFAULT_BASE_BLOCK_MS;
    this.maxBlockMs = options.maxBlockMs ?? DEFAULT_MAX_BLOCK_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Длина самого длинного хранимого ключа — для контроля границы памяти в тестах. */
  get maxStoredKeyLength(): number {
    let max = 0;
    for (const key of this.entries.keys()) {
      max = Math.max(max, key.length);
    }
    return max;
  }

  /** Нормализация ключа: длинные значения заменяются на SHA-256-хеш. */
  private static normalizeKey(key: string): string {
    if (key.length <= MAX_KEY_LENGTH) return key;
    return `sha256:${createHash("sha256").update(key).digest("hex")}`;
  }

  /**
   * Проверка, разрешена ли попытка. Не изменяет счётчики.
   * Если заблокировано несколько ключей — возвращается наибольший остаток.
   */
  check(keys: string[]): RateLimitCheck {
    const now = Date.now();
    let retryAfterMs = 0;

    for (const rawKey of keys) {
      const entry = this.entries.get(AuthRateLimiter.normalizeKey(rawKey));
      if (entry && entry.blockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - now);
      }
    }

    if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
    return { allowed: true };
  }

  /**
   * Регистрация неудачной попытки авторизации по всем ключам.
   * При достижении лимита ключ блокируется на
   * min(baseBlockMs * 2^blockCount, maxBlockMs).
   */
  recordFailure(keys: string[]): void {
    const now = Date.now();

    for (const rawKey of keys) {
      const key = AuthRateLimiter.normalizeKey(rawKey);
      let entry = this.entries.get(key);

      if (!entry) {
        entry = { failures: 0, windowStart: now, blockedUntil: 0, blockCount: 0 };
      } else {
        // Поднимаем запись в конец Map (LRU-семантика для FIFO-cap)
        this.entries.delete(key);
        if (now - entry.windowStart > this.windowMs) {
          entry.failures = 0;
          entry.windowStart = now;
        }
      }

      entry.failures++;

      if (entry.failures >= this.maxAttempts) {
        const blockMs = Math.min(this.baseBlockMs * 2 ** entry.blockCount, this.maxBlockMs);
        entry.blockedUntil = now + blockMs;
        entry.blockCount++;
        entry.failures = 0;
        entry.windowStart = now;
        logger.warning(
          `Превышен лимит неудачных попыток авторизации для ${key} — блокировка на ${Math.round(blockMs / 1000)}с`,
        );
      }

      this.entries.set(key, entry);
    }

    this.enforceCap();
  }

  /** Успешная авторизация — сбрасываем историю по всем ключам. */
  recordSuccess(keys: string[]): void {
    for (const rawKey of keys) {
      this.entries.delete(AuthRateLimiter.normalizeKey(rawKey));
    }
  }

  /** Удаление записей с истекшим окном и завершившейся блокировкой. */
  cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.entries) {
      const windowExpired = now - entry.windowStart > this.windowMs;
      const blockExpired = entry.blockedUntil <= now;
      if (windowExpired && blockExpired) {
        this.entries.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`Очищено записей rate-limit: ${cleaned}`);
    }
  }

  startCleanupTask(intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS): void {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), intervalMs);
    logger.debug(`Запущена задача очистки rate-limit (интервал: ${intervalMs}ms)`);
  }

  stopCleanupTask(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Жёсткий FIFO-cap: Map сохраняет порядок вставки, при превышении
   * лимита удаляются самые старые записи.
   */
  private enforceCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
