import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("packages/core/src/check.ts", "utf8");
assert.match(source, /evidence_grade: commandResults\.length > 0 \? "executed" : "reported"/);
assert.match(source, /Evidence grade:/);
console.log("golden replay checks passed");
