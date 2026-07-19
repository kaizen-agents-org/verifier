import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("packages/core/src/eval/fixture-run.ts", "utf8");
assert.match(source, /verifyTimeoutMs: fixtureCase\.timeoutMinutes \* 60_000/);
console.log("fixture timeout wiring check passed");
