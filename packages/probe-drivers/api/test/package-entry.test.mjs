import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LaunchError, validateRequestExpectation } from "@verifier/probe-sdk";

test("the built probe SDK package entry exposes runtime and declaration artifacts", async () => {
  const declarations = fileURLToPath(
    new URL("../../../probe-sdk/dist/index.d.ts", import.meta.url)
  );
  await access(declarations);
  assert.equal(new LaunchError("smoke").name, "LaunchError");
  assert.equal(validateRequestExpectation({ status: 200 }), undefined);
});
