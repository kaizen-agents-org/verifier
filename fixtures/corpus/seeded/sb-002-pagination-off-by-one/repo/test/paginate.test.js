import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "../src/paginate.js";

test("paginate returns the first page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 0, 2), [1, 2]);
});

test("paginate returns the second page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [3, 4]);
});
