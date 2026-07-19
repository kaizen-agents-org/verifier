import assert from "node:assert/strict";
import test from "node:test";
import { cacheKey } from "../src/cache-key.js";

test("keeps ASCII identifiers distinct", () => {
  assert.notEqual(cacheKey("user", "alice"), cacheKey("user", "alina"));
});
