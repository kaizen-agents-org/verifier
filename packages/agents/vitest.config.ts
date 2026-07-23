import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@verifier/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@verifier/probe-sdk": fileURLToPath(new URL("../probe-sdk/src/index.ts", import.meta.url)),
      "@verifier/probe-driver-cli": fileURLToPath(
        new URL("../probe-drivers/cli/src/index.ts", import.meta.url)
      ),
      "@verifier/probe-driver-api": fileURLToPath(
        new URL("../probe-drivers/api/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000
  }
});
