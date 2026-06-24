import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts — только bootstrap, main.ts завязан на process.argv/exit
      exclude: ["src/index.ts", "src/auth/index.ts"],
      reporter: ["text", "html", "lcov"],
    },
  },
});
