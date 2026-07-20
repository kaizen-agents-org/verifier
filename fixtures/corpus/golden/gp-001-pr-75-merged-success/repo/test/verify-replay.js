import assert from "node:assert/strict";
import { buildVerdict, renderMarkdownReport } from "../packages/core/src/check.ts";

const executed = buildVerdict({ confidence: 90, risk: "low", verdict: "pass" }, "mergeable", [], [
  { command: "npm test" }
]);
const reported = buildVerdict(
  { confidence: 90, risk: "low", verdict: "pass" },
  "mergeable",
  [],
  []
);
assert.equal(executed.evidence_grade, "executed");
assert.equal(reported.evidence_grade, "reported");
assert.match(renderMarkdownReport(executed), /Evidence grade: executed/);
console.log("golden replay checks passed");
