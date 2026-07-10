import assert from "node:assert/strict";
import { test } from "node:test";
import { average, maxValue } from "../src/stats.js";

test("average of a non-empty list", () => {
  assert.equal(average([2, 4, 6]), 4);
});

test("maxValue of a non-empty list", () => {
  assert.equal(maxValue([2, 9, 4]), 9);
});
