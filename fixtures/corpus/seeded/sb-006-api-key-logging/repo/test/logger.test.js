import assert from "node:assert/strict";
import test from "node:test";
import { logStartup } from "../src/logger.js";

test("logs the service name", () => {
  const lines = [];
  logStartup({ SERVICE_NAME: "billing" }, (line) => lines.push(line));
  assert.deepEqual(lines, ["service=billing"]);
});
