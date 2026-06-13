import { describe, expect, it } from "vitest";
import { evaluateMinimalVerdict } from "../src/index.js";

describe("evaluateMinimalVerdict", () => {
  it("opens a PR for clean inputs with task, diff, logs, and builder report", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Add validation to the signup form",
      diff: "diff --git a/signup.ts b/signup.ts\n+validateEmail(input.email)",
      verifyLogs: "typecheck passed\nall tests passed\n0 failures",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.risk).toBe("low");
    expect(verdict.confidence).toBeGreaterThanOrEqual(80);
  });

  it("blocks PR creation when verify logs contain blocking failures", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Keep API authorization intact",
      diff: "diff --git a/api.ts b/api.ts\n-authz.check()\n+return ok()",
      verifyLogs: "Tests failed with exit code 1",
      builderReport: "builder found blocker: auth regression"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.length).toBeGreaterThanOrEqual(2);
    expect(verdict.risk).toBe("high");
  });

  it("needs context when task or diff is missing", () => {
    const verdict = evaluateMinimalVerdict({
      task: "",
      diff: "",
      verifyLogs: "all tests passed",
      builderReport: "build ok"
    });

    expect(verdict.verdict).toBe("needs_context");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.map((item) => item.source)).toContain("task");
    expect(verdict.should_fix.map((item) => item.source)).toContain("diff");
  });

  it("keeps high-risk diffs as should_fix when logs are otherwise clean", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Refactor billing token handling",
      diff: "diff --git a/billing.ts b/billing.ts\n+const token = req.body.token",
      verifyLogs: "all tests passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr_with_warning");
    expect(verdict.risk).toBe("medium");
    expect(verdict.should_fix.some((item) => item.source === "diff")).toBe(true);
  });

  it("opens PRs with a warning for non-blocking verification risk signals", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "all tests passed\nwarning: snapshot was skipped",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr_with_warning");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.source === "verify_logs")).toBe(true);
  });
});
