import assert from "node:assert/strict";
import test from "node:test";
import { featureB } from "../src/features.js";

test("feature B returns its configured value", () => {
  assert.equal(featureB(), "B");
});
