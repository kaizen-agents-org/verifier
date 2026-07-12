import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCurrency } from "../src/format-currency.js";

test("formats whole dollars", () => {
  assert.equal(formatCurrency(500), "$5.00");
});

test("formats cents", () => {
  assert.equal(formatCurrency(1234), "$12.34");
});
