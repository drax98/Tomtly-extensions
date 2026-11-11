import { defineConfig } from "vitest/config";

// The tests run in plain Node against a mock of the host API (test/harness.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["*/*.ts"], exclude: ["**/*.d.ts", "test/**", "sdk/**"], reporter: ["text"] },
  },
});
