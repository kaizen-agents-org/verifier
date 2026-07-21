import assert from "node:assert/strict";
import test from "node:test";
import { normalize } from "../src/normalize.js";

test("normalizes whitespace and case", () => {
  assert.equal(normalize("  Hello  "), "hello");
});
