import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuth2Service, OAuth2Store } from "../src/auth/oauth2.js";

function makePair(graceWindowMs = 60_000) {
  const store = new OAuth2Store({ graceWindowMs });
  const svc = new OAuth2Service(store, 120, 3600, 1_209_600);
  return { store, svc };
}

/** Вычисляет S256 code_challenge для заданного verifier (как в RFC 7636). */
function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Создаёт уникальный временный каталог (атомарно, с правами 0700) и возвращает
 * путь к файлу снапшота внутри него вместе с функцией очистки.
 */
async function makeSnapshotFile(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "oauth2-test-"));
  return {
    path: join(dir, "snapshot.json"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("OAuth2Service — PKCE", () => {
  it("validatePkce принимает корректный verifier", () => {
    const { svc } = makePair();
    const verifier = "the-quick-brown-fox-verifier-1234567890";
    expect(svc.validatePkce(verifier, challengeFor(verifier))).toBe(true);
  });

  it("validatePkce отклоняет неверный verifier", () => {
    const { svc } = makePair();
    const verifier = "correct-verifier";
    expect(svc.validatePkce("wrong-verifier", challengeFor(verifier))).toBe(false);
  });
});

describe("OAuth2Service — authorization code flow", () => {
  const verifier = "verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = challengeFor(verifier);

  it("обменивает код на токены при верных redirect_uri и verifier", () => {
    const { svc } = makePair();
    const code = svc.generateAuthorizationCode("user", "pass", "http://cb", challenge);
    const tokens = svc.exchangeCodeForTokens(code, "http://cb", verifier);
    expect(tokens).toBeDefined();
    expect(svc.validateAccessToken(tokens!.accessToken)).toEqual({
      login: "user",
      password: "pass",
    });
  });

  it("отклоняет неверный code_verifier (PKCE)", () => {
    const { svc } = makePair();
    const code = svc.generateAuthorizationCode("user", "pass", "http://cb", challenge);
    expect(svc.exchangeCodeForTokens(code, "http://cb", "wrong-verifier")).toBeUndefined();
  });

  it("отклоняет несовпадающий redirect_uri", () => {
    const { svc } = makePair();
    const code = svc.generateAuthorizationCode("user", "pass", "http://cb", challenge);
    expect(svc.exchangeCodeForTokens(code, "http://evil", verifier)).toBeUndefined();
  });

  it("код одноразовый — повторный обмен отклоняется", () => {
    const { svc } = makePair();
    const code = svc.generateAuthorizationCode("user", "pass", "http://cb", challenge);
    expect(svc.exchangeCodeForTokens(code, "http://cb", verifier)).toBeDefined();
    expect(svc.exchangeCodeForTokens(code, "http://cb", verifier)).toBeUndefined();
  });
});

describe("OAuth2Service — access token", () => {
  it("validateAccessToken возвращает креденшилы для валидного токена", () => {
    const { svc } = makePair();
    const tokens = svc.generateTokensFromCredentials("alice", "secret");
    expect(svc.validateAccessToken(tokens.accessToken)).toEqual({
      login: "alice",
      password: "secret",
    });
  });

  it("validateAccessToken возвращает undefined для неизвестного токена", () => {
    const { svc } = makePair();
    expect(svc.validateAccessToken("nonexistent")).toBeUndefined();
  });
});

describe("OAuth2Service — refresh-ротация и grace-window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ротирует refresh-токен на свежую пару", () => {
    const { svc } = makePair();
    const initial = svc.generateTokensFromCredentials("user", "pass");
    const result = svc.refreshTokens(initial.refreshToken);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.tokens.refreshToken).not.toBe(initial.refreshToken);
    expect(svc.validateAccessToken(result.tokens.accessToken)).toEqual({
      login: "user",
      password: "pass",
    });
  });

  it("повторное использование в grace-window идемпотентно отдаёт ту же пару", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { svc } = makePair(1000);
    const initial = svc.generateTokensFromCredentials("user", "pass");

    const first = svc.refreshTokens(initial.refreshToken);
    expect(first.kind).toBe("ok");

    vi.setSystemTime(500); // в пределах grace-window (1000 мс)
    const replay = svc.refreshTokens(initial.refreshToken);
    expect(replay.kind).toBe("ok");
    if (first.kind !== "ok" || replay.kind !== "ok") return;
    expect(replay.tokens.accessToken).toBe(first.tokens.accessToken);
    expect(replay.tokens.refreshToken).toBe(first.tokens.refreshToken);
  });

  it("повторное использование после grace-window отзывает всю семью токенов", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { svc } = makePair(1000);
    const initial = svc.generateTokensFromCredentials("user", "pass");

    const first = svc.refreshTokens(initial.refreshToken);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    vi.setSystemTime(2000); // за пределами grace-window
    const replay = svc.refreshTokens(initial.refreshToken);
    expect(replay.kind).toBe("replay");

    // Семья отозвана: и выданный ранее access, и ротированный refresh больше не валидны
    expect(svc.validateAccessToken(first.tokens.accessToken)).toBeUndefined();
    expect(svc.refreshTokens(first.tokens.refreshToken).kind).toBe("invalid");
  });

  it("неизвестный refresh-токен → invalid", () => {
    const { svc } = makePair();
    expect(svc.refreshTokens("nonexistent").kind).toBe("invalid");
  });
});

describe("OAuth2Store — персистентность снапшота", () => {
  it("сохраняет и восстанавливает токены через снапшот", async () => {
    const { path, cleanup } = await makeSnapshotFile();
    try {
      const store = new OAuth2Store({ persistencePath: path });
      const svc = new OAuth2Service(store, 120, 3600, 1_209_600);
      const tokens = svc.generateTokensFromCredentials("alice", "secret");
      await store.saveSnapshot();

      // Файл создан и содержит валидный JSON
      const raw = await readFile(path, "utf8");
      expect(JSON.parse(raw)).toMatchObject({ version: 1 });

      const restored = new OAuth2Store({ persistencePath: path });
      await restored.loadSnapshot();
      const svc2 = new OAuth2Service(restored, 120, 3600, 1_209_600);

      expect(svc2.validateAccessToken(tokens.accessToken)).toEqual({
        login: "alice",
        password: "secret",
      });
      expect(svc2.refreshTokens(tokens.refreshToken).kind).toBe("ok");
    } finally {
      await cleanup();
    }
  });

  it("отбрасывает истёкшие записи при загрузке", async () => {
    const { path, cleanup } = await makeSnapshotFile();
    try {
      const now = Date.now();
      const payload = {
        version: 1,
        savedAt: now,
        accessTokens: [
          ["expired", { login: "x", password: "y", exp: now - 1000, family: "f1" }],
          ["valid", { login: "a", password: "b", exp: now + 100_000, family: "f2" }],
        ],
        refreshTokens: [],
      };
      await writeFile(path, JSON.stringify(payload), "utf8");

      const store = new OAuth2Store({ persistencePath: path });
      await store.loadSnapshot();
      const svc = new OAuth2Service(store);

      expect(svc.validateAccessToken("valid")).toEqual({ login: "a", password: "b" });
      expect(svc.validateAccessToken("expired")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("игнорирует повреждённый снапшот без выброса исключения", async () => {
    const { path, cleanup } = await makeSnapshotFile();
    try {
      await writeFile(path, "{ this is not json", "utf8");
      const store = new OAuth2Store({ persistencePath: path });
      await expect(store.loadSnapshot()).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("молча стартует с пустым хранилищем при отсутствии файла", async () => {
    const { path, cleanup } = await makeSnapshotFile();
    try {
      const store = new OAuth2Store({ persistencePath: path });
      await expect(store.loadSnapshot()).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
