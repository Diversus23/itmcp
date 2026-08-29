/**
 * Тесты безопасности OneCClient.downloadFile (инструмент save_file):
 * санитизация имени файла из Content-Disposition и ограничение записи
 * белым каталогом (allowedDir).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { OneCClient } from "../src/onec-client.js";

let server: Server;
let baseUrl: string;
let contentDispositionFilename = "ok.bin";
let allowedDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", `attachment; filename="${contentDispositionFilename}"`);
      res.end("DATA");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  allowedDir = await mkdtemp(join(tmpdir(), "mcp-save-test-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(allowedDir, { recursive: true, force: true });
});

function makeClient(): OneCClient {
  return new OneCClient(baseUrl, "admin", "pass");
}

describe("downloadFile — санитизация имени файла", () => {
  it("отбрасывает path traversal в filename из Content-Disposition (backslash)", async () => {
    contentDispositionFilename = "..\\..\\evil.txt";
    const client = makeClient();
    try {
      const result = await client.downloadFile("ref_files_1", undefined, allowedDir);
      expect(basename(result.path)).toBe("evil.txt");
      expect(dirname(result.path)).toBe(resolve(allowedDir));
    } finally {
      await client.close();
    }
  });

  it("отбрасывает path traversal в filename из Content-Disposition (slash)", async () => {
    contentDispositionFilename = "../../evil2.txt";
    const client = makeClient();
    try {
      const result = await client.downloadFile("ref_files_2", undefined, allowedDir);
      expect(basename(result.path)).toBe("evil2.txt");
      expect(dirname(result.path)).toBe(resolve(allowedDir));
    } finally {
      await client.close();
    }
  });
});

describe("downloadFile — белый каталог (allowedDir)", () => {
  it("сохраняет файл внутри allowedDir по умолчанию", async () => {
    contentDispositionFilename = "report.pdf";
    const client = makeClient();
    try {
      const result = await client.downloadFile("ref_files_3", undefined, allowedDir);
      expect(dirname(result.path)).toBe(resolve(allowedDir));
      expect(await readFile(result.path, "utf8")).toBe("DATA");
    } finally {
      await client.close();
    }
  });

  it("разрешает относительный destPath внутри allowedDir", async () => {
    contentDispositionFilename = "x.bin";
    const client = makeClient();
    try {
      const result = await client.downloadFile("ref_files_4", "sub/rel.bin", allowedDir);
      expect(result.path).toBe(resolve(allowedDir, "sub", "rel.bin"));
      expect(await readFile(result.path, "utf8")).toBe("DATA");
    } finally {
      await client.close();
    }
  });

  it("отвергает абсолютный destPath вне allowedDir", async () => {
    contentDispositionFilename = "x.bin";
    const client = makeClient();
    try {
      await expect(
        client.downloadFile("ref_files_5", join(tmpdir(), "outside.bin"), allowedDir),
      ).rejects.toThrow(/outside/i);
    } finally {
      await client.close();
    }
  });

  it("отвергает traversal через destPath", async () => {
    contentDispositionFilename = "x.bin";
    const client = makeClient();
    try {
      await expect(client.downloadFile("ref_files_6", "../escape.bin", allowedDir)).rejects.toThrow(
        /outside/i,
      );
    } finally {
      await client.close();
    }
  });

  it("без allowedDir сохраняет прежнее поведение: destPath используется как есть", async () => {
    contentDispositionFilename = "x.bin";
    const dest = join(allowedDir, "legacy.bin");
    const client = makeClient();
    try {
      const result = await client.downloadFile("ref_files_7", dest);
      expect(result.path).toBe(dest);
      expect(await readFile(dest, "utf8")).toBe("DATA");
    } finally {
      await client.close();
    }
  });
});
