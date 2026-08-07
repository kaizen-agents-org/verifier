import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliProbeDriver } from "@verifier/probe-driver-cli";

test("the built CLI probe driver package entry exposes runtime and declaration artifacts", async () => {
  const declarations = fileURLToPath(
    new URL("../dist/index.d.ts", import.meta.url)
  );
  await access(declarations);
  assert.equal(new CliProbeDriver({ commands: {} }).targetType, "cli");
});
