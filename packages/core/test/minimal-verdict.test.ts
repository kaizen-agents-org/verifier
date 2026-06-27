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

  it("blocks high-risk diffs without targeted verification evidence", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Refactor billing token handling",
      diff: "diff --git a/billing.ts b/billing.ts\n+const token = req.body.token",
      verifyLogs: "all tests passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.risk).toBe("high");
    expect(verdict.must_fix.some((item) => item.source === "diff")).toBe(true);
  });

  it("opens high-risk diffs with a warning when targeted verification is present", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Refactor billing token handling",
      diff: "diff --git a/billing.ts b/billing.ts\n+const token = req.body.token",
      verifyLogs: "billing token tests passed",
      builderReport: "Verified billing token handling with focused tests."
    });

    expect(verdict.verdict).toBe("open_pr_with_warning");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.source === "diff")).toBe(true);
  });

  it("accepts targeted high-risk coverage from the builder report", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Keep authorization checks intact",
      diff: "diff --git a/api.ts b/api.ts\n+authz.check(req)",
      verifyLogs: "all tests passed",
      builderReport: "Verified authz behavior with focused tests."
    });

    expect(verdict.verdict).toBe("open_pr_with_warning");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.source === "diff")).toBe(true);
  });

  it("blocks authz shorthand diffs without targeted verification evidence", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Keep authorization checks intact",
      diff: "diff --git a/api.ts b/api.ts\n+authz.check(req)",
      verifyLogs: "all tests passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.message.includes("auth/authz"))).toBe(true);
  });

  it("does not flag high-risk terms embedded inside identifiers", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Refactor verdict parsing",
      diff: "diff --git a/cli.ts b/cli.ts\n+const input = VerdictInputSchema.parse(raw)",
      verifyLogs: "all tests passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.risk).toBe("low");
    expect(verdict.should_fix.some((item) => item.source === "diff")).toBe(false);
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

  it("treats intentionally skipped verification as a non-blocking risk", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "all tests passed\npnpm schema:check skipped because schema service is unavailable",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr_with_warning");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.evidence?.includes("skipped because"))).toBe(true);
  });

  it("needs context when no positive mechanical verification evidence is available", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "",
      builderReport: "Implemented the requested copy update."
    });

    expect(verdict.verdict).toBe("needs_context");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.source === "verify_logs")).toBe(true);
  });

  it("does not treat arbitrary success prose as positive verification evidence", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "manual review successful",
      builderReport: "Implemented the requested copy update."
    });

    expect(verdict.verdict).toBe("needs_context");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.source === "verify_logs")).toBe(true);
  });

  it("needs context when mechanical verification is not configured", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "Verification commands are not configured",
      builderReport: "Implemented the requested copy update."
    });

    expect(verdict.verdict).toBe("needs_context");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.message.includes("not configured"))).toBe(true);
  });

  it("does not treat unrelated not-configured prose as missing verification", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs:
        "all tests passed\npreview banner is not configured in this fixture\npreview build is not configured in this fixture",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.message.includes("not configured"))).toBe(false);
  });

  it("blocks when a configured verification command did not pass", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "- [x] pnpm typecheck\n- [ ] pnpm test",
      builderReport: "Implemented the requested copy update."
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.source === "verify_logs")).toBe(true);
  });

  it("blocks when a configured verification command was not run", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "pnpm schema:check was not run",
      builderReport: "Implemented the requested copy update."
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.evidence?.includes("not run"))).toBe(true);
  });
});
