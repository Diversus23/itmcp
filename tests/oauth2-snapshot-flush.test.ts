/**
 * Регрессионный тест: финальный saveSnapshot (graceful shutdown) не должен
 * возвращать уже идущую запись со старым payload — иначе токены, ротированные
 * за последние секунды перед остановкой, теряются, и клиент после рестарта
 * получает invalid_grant и принудительную реавторизацию.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Управляемая задержка первой записи writeFile: тест стартует снапшот,
// дожидается, пока payload уже сформирован и запись реально началась,
// меняет состояние store и лишь потом отпускает запись.
const gate = {
  release: (): void => undefined,
  reached: (): void => undefined,
  whenReached: Promise.resolve(),
  armed: false,
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (gate.armed) {
        gate.armed = false;
        gate.reached();
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return actual.writeFile(...args);
    },
  };
});

// Импорт после vi.mock, чтобы модуль получил замоканный fs/promises
const { OAuth2Store } = await import("../src/auth/oauth2.js");

describe("OAuth2Store — финальный снапшот при shutdown", () => {
  it("saveSnapshot, вызванный во время идущей записи, дописывает свежие изменения", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth2-flush-"));
    const path = join(dir, "snapshot.json");
    try {
      const store = new OAuth2Store({ persistencePath: path });
      store.saveAccessToken("token-old", {
        login: "u",
        password: "p",
        exp: Date.now() + 100_000,
        family: "f",
      });

      // Первая запись повисает на gate
      gate.armed = true;
      gate.whenReached = new Promise<void>((resolve) => {
        gate.reached = resolve;
      });
      const first = store.saveSnapshot();

      // Дожидаемся момента, когда payload первой записи уже сформирован
      await gate.whenReached;

      // Пока запись идёт — появляется новый токен (например, ротация
      // прямо перед SIGTERM)
      store.saveAccessToken("token-new", {
        login: "u",
        password: "p",
        exp: Date.now() + 100_000,
        family: "f",
      });

      // «Финальный» снапшот из dispose(): обязан дождаться и записать
      // состояние, включающее token-new
      const final = store.saveSnapshot();
      // Отпускаем первую запись
      setTimeout(() => gate.release(), 10);
      await first;
      await final;

      const raw = await readFile(path, "utf8");
      const payload = JSON.parse(raw) as { accessTokens: Array<[string, unknown]> };
      const tokens = payload.accessTokens.map(([t]) => t);
      expect(tokens).toContain("token-new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
