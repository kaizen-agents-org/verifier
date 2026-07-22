import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@verifier/core": fileURLToPath(new URL("../../core/src/index.ts", import.meta.url)),
      "@verifier/probe-sdk": fileURLToPath(new URL("../../probe-sdk/src/index.ts", import.meta.url))
    }
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 }
});
