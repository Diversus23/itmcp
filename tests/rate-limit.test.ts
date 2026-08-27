import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuthRateLimiter } from "../src/auth/rate-limit.js";

const OPTS = {
  maxAttempts: 5,
  windowMs: 900_000, // 15 минут
  baseBlockMs: 60_000, // 1 минута
  maxBlockMs: 3_600_000, // 1 час
};

function makeLimiter(overrides: Partial<typeof OPTS & { maxEntries: number }> = {}) {
  return new AuthRateLimiter({ ...OPTS, ...overrides });
}

/** Регистрирует n неудачных попыток для набора ключей. */
function fail(limiter: AuthRateLimiter, keys: string[], n: number) {
  for (let i = 0; i < n; i++) limiter.recordFailure(keys);
}

describe("AuthRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("разрешает попытки, пока лимит не достигнут", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:user"], OPTS.maxAttempts - 1);
    expect(limiter.check(["login:user"])).toEqual({ allowed: true });
  });

  it("блокирует ключ после maxAttempts неудач", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:user"], OPTS.maxAttempts);
    const result = limiter.check(["login:user"]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(OPTS.baseBlockMs);
    }
  });

  it("check не увеличивает счётчик попыток", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 100; i++) limiter.check(["login:user"]);
    expect(limiter.check(["login:user"])).toEqual({ allowed: true });
  });

  it("разблокирует после истечения срока блокировки", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:user"], OPTS.maxAttempts);
    expect(limiter.check(["login:user"]).allowed).toBe(false);

    vi.advanceTimersByTime(OPTS.baseBlockMs + 1);
    expect(limiter.check(["login:user"]).allowed).toBe(true);
  });

  it("удваивает длительность блокировки при повторных сериях неудач", () => {
    const limiter = makeLimiter();

    // Первая серия — блокировка на baseBlockMs
    fail(limiter, ["login:user"], OPTS.maxAttempts);
    vi.advanceTimersByTime(OPTS.baseBlockMs + 1);

    // Вторая серия — блокировка должна быть ~2x baseBlockMs
    fail(limiter, ["login:user"], OPTS.maxAttempts);
    const result = limiter.check(["login:user"]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(OPTS.baseBlockMs);
      expect(result.retryAfterMs).toBeLessThanOrEqual(2 * OPTS.baseBlockMs);
    }
  });

  it("не превышает потолок maxBlockMs при эскалации", () => {
    const limiter = makeLimiter({ maxBlockMs: 3 * OPTS.baseBlockMs });

    for (let series = 0; series < 10; series++) {
      fail(limiter, ["login:user"], OPTS.maxAttempts);
      const result = limiter.check(["login:user"]);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfterMs).toBeLessThanOrEqual(3 * OPTS.baseBlockMs);
        vi.advanceTimersByTime(result.retryAfterMs + 1);
      }
    }
  });

  it("recordSuccess сбрасывает накопленные неудачи", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:user"], OPTS.maxAttempts - 1);
    limiter.recordSuccess(["login:user"]);
    fail(limiter, ["login:user"], OPTS.maxAttempts - 1);
    expect(limiter.check(["login:user"])).toEqual({ allowed: true });
  });

  it("счётчик неудач обнуляется после истечения окна windowMs", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:user"], OPTS.maxAttempts - 1);
    vi.advanceTimersByTime(OPTS.windowMs + 1);
    fail(limiter, ["login:user"], 1);
    expect(limiter.check(["login:user"])).toEqual({ allowed: true });
  });

  it("блокировка любого из переданных ключей блокирует запрос целиком", () => {
    const limiter = makeLimiter();
    // Атакующий с одного IP перебирает разные логины — блокируется IP
    for (let i = 0; i < OPTS.maxAttempts; i++) {
      limiter.recordFailure(["ip:1.2.3.4", `login:user${i}`]);
    }
    const result = limiter.check(["ip:1.2.3.4", "login:fresh-user"]);
    expect(result.allowed).toBe(false);
  });

  it("независимые ключи не влияют друг на друга", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:victim"], OPTS.maxAttempts);
    expect(limiter.check(["login:other"])).toEqual({ allowed: true });
  });

  it("retryAfterMs соответствует самому долгому из заблокированных ключей", () => {
    const limiter = makeLimiter();
    // login заблокирован дважды (эскалация), ip — один раз
    fail(limiter, ["login:user"], OPTS.maxAttempts);
    vi.advanceTimersByTime(OPTS.baseBlockMs + 1);
    fail(limiter, ["login:user"], OPTS.maxAttempts);
    fail(limiter, ["ip:1.2.3.4"], OPTS.maxAttempts);

    const combined = limiter.check(["ip:1.2.3.4", "login:user"]);
    const loginOnly = limiter.check(["login:user"]);
    expect(combined.allowed).toBe(false);
    expect(loginOnly.allowed).toBe(false);
    if (!combined.allowed && !loginOnly.allowed) {
      expect(combined.retryAfterMs).toBe(loginOnly.retryAfterMs);
    }
  });

  it("cleanupExpired удаляет истекшие записи", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:a", "login:b"], 2);
    expect(limiter.size).toBe(2);

    vi.advanceTimersByTime(OPTS.windowMs + 1);
    limiter.cleanupExpired();
    expect(limiter.size).toBe(0);
  });

  it("cleanupExpired сохраняет активные блокировки", () => {
    const limiter = makeLimiter();
    fail(limiter, ["login:blocked"], OPTS.maxAttempts);

    vi.advanceTimersByTime(OPTS.baseBlockMs / 2);
    limiter.cleanupExpired();
    expect(limiter.check(["login:blocked"]).allowed).toBe(false);
  });

  it("длинный ключ обрабатывается согласованно (нормализация между вызовами)", () => {
    const limiter = makeLimiter();
    const longKey = `login:${"a".repeat(10_000)}`;
    fail(limiter, [longKey], OPTS.maxAttempts);
    expect(limiter.check([longKey]).allowed).toBe(false);
  });

  it("разные длинные ключи с общим префиксом не коллидируют", () => {
    const limiter = makeLimiter();
    const keyA = `login:${"a".repeat(10_000)}X`;
    const keyB = `login:${"a".repeat(10_000)}Y`;
    fail(limiter, [keyA], OPTS.maxAttempts);
    expect(limiter.check([keyA]).allowed).toBe(false);
    expect(limiter.check([keyB]).allowed).toBe(true);
  });

  it("recordSuccess сбрасывает счётчик и для длинного ключа", () => {
    const limiter = makeLimiter();
    const longKey = `login:${"b".repeat(10_000)}`;
    fail(limiter, [longKey], OPTS.maxAttempts - 1);
    limiter.recordSuccess([longKey]);
    fail(limiter, [longKey], OPTS.maxAttempts - 1);
    expect(limiter.check([longKey])).toEqual({ allowed: true });
  });

  it("длинный ключ не сохраняется в памяти дословно", () => {
    const limiter = makeLimiter();
    const longKey = `login:${"c".repeat(100_000)}`;
    fail(limiter, [longKey], 1);
    expect(limiter.size).toBe(1);
    expect(limiter.maxStoredKeyLength).toBeLessThan(200);
  });

  it("вытесняет самые старые записи при превышении maxEntries", () => {
    const limiter = makeLimiter({ maxEntries: 3 });
    fail(limiter, ["login:a"], 1);
    fail(limiter, ["login:b"], 1);
    fail(limiter, ["login:c"], 1);
    fail(limiter, ["login:d"], 1);
    expect(limiter.size).toBe(3);
  });
});
