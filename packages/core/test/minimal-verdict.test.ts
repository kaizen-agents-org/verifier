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
    expect(verdict.evidence_grade).toBe("reported");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.risk).toBe("low");
    expect(verdict.confidence).toBeGreaterThanOrEqual(80);
  });

  it("does not block clean named tests that contain hard-failure domain terms", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Add regression coverage for parser recovery",
      diff: "diff --git a/parser.test.ts b/parser.test.ts\n+it('handles parser errors cleanly', () => {})",
      verifyLogs:
        "typecheck passed\nerror handling tests passed\nexception path tests passed\npanic recovery test passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix).toHaveLength(0);
  });

  it("does not block clean per-test pass lines that mention blocked failures", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Add provider fallback regression tests",
      diff: "diff --git a/AgentRunner.test.ts b/AgentRunner.test.ts\n+it('stops fallback for provider-blocked failures unless the provider opts in', () => {})",
      verifyLogs:
        "✔ stops fallback for provider-blocked failures unless the provider opts in (368.120834ms)\n✔ returns exit code 2 for blocked build results (30.516458ms)",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix).toHaveLength(0);
  });

  it("does not block common clean test summaries with zero failures", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update test coverage",
      diff: "diff --git a/signup.test.ts b/signup.test.ts\n+expect(result).toBe(true)",
      verifyLogs: "Tests: 42 passed, 0 failed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
  });

  it("does not block zero-error summary lines when other positive evidence exists", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update lint reporting",
      diff: "diff --git a/lint.ts b/lint.ts\n+return formatLintSummary(result)",
      verifyLogs: "all tests passed\nErrors: 0\nNo errors found",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
  });

  it("does not block cargo test summaries with zero failures", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Refactor Rust parser",
      diff: "diff --git a/src/parser.rs b/src/parser.rs\n+let result = parse(input);",
      verifyLogs: "test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
  });

  it("still blocks mixed-status named test lines with explicit failures", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Add regression coverage for parser recovery",
      diff: "diff --git a/parser.test.ts b/parser.test.ts\n+it('handles parser errors cleanly', () => {})",
      verifyLogs: "error handling tests passed; 1 error",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.source === "verify_logs")).toBe(true);
  });

  it("blocks mixed-status lines that append errors after a clean result", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Add regression coverage for verifier logs",
      diff: "diff --git a/verifier.test.ts b/verifier.test.ts\n+it('reports lint configuration errors', () => {})",
      verifyLogs: "unit tests passed; lint error: no config found",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.source === "verify_logs")).toBe(true);
  });

  it("blocks pass-prefixed summary lines with explicit failures", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Tighten verification log parsing",
      diff: "diff --git a/verifier.ts b/verifier.ts\n+collectHardFailures(logs)",
      verifyLogs: "PASS integration: 1 failed\nok pnpm test exit code 1",
      builderReport: "Updated verifier parsing."
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.filter((item) => item.source === "verify_logs")).toHaveLength(2);
  });

  it("does not turn builder report prose about fixed errors into blockers", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Fix retry logic",
      diff: "diff --git a/retry.ts b/retry.ts\n+return retry(operation)",
      verifyLogs: "all tests passed",
      builderReport: "Fixed the error in the retry logic and added coverage."
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
  });

  it("does not treat non-blocking builder report prose as a blocking failure", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update cleanup logic",
      diff: "diff --git a/cleanup.ts b/cleanup.ts\n+cleanupTemporaryFiles()",
      verifyLogs: "all tests passed",
      builderReport: "One non-blocking cleanup was deferred."
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix).toHaveLength(0);
  });

  it("surfaces eslint warning summaries without blocking", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update lint configuration",
      diff: "diff --git a/eslint.config.js b/eslint.config.js\n+export default []",
      verifyLogs: "✖ 3 problems (0 errors, 3 warnings)",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr_with_warning");
    expect(verdict.must_fix).toHaveLength(0);
    expect(verdict.should_fix.some((item) => item.source === "verify_logs")).toBe(true);
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

  it("does not block removals of hard-coded secrets when no new secret is added", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Remove a hard-coded database password",
      diff:
        "diff --git a/config.ts b/config.ts\n" +
        "-const password = 'hardcoded-password'\n" +
        "+const databaseConfig = loadDatabaseConfig()",
      verifyLogs: "all tests passed",
      builderReport: "Removed the hard-coded credential and verified config loading."
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix.some((item) => item.message.includes("secrets/credentials"))).toBe(false);
  });

  it("does not block harmless delete wording in added comments", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Document cleanup behavior",
      diff:
        "diff --git a/cleanup.ts b/cleanup.ts\n" +
        "+// Delete stale local fixtures manually when debugging old runs.",
      verifyLogs: "all tests passed",
      builderReport: "Updated cleanup documentation."
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.must_fix.some((item) => item.message.includes("destructive"))).toBe(false);
  });

  it("still blocks removed authorization checks without targeted verification evidence", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Refactor admin update handler",
      diff:
        "diff --git a/admin.ts b/admin.ts\n" +
        "-requireAuthorization(request)\n" +
        "+return ok({ status: 'updated' })",
      verifyLogs: "all tests passed",
      builderReport: "Refactored the admin update handler."
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.message.includes("auth/authz"))).toBe(true);
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
      diff: "diff --git a/cli.ts b/cli.ts\n+const input = VerdictInputSchema.parse(raw)\n+await run('pnpm schema:check')\n+writeFile('schemas/verdict.schema.json', schema)",
      verifyLogs: "all tests passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("open_pr");
    expect(verdict.risk).toBe("low");
    expect(verdict.should_fix.some((item) => item.source === "diff")).toBe(false);
  });

  it("blocks database schema diffs without targeted verification evidence", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Add user email database column",
      diff: "diff --git a/migrations/001.sql b/migrations/001.sql\n+alter table users add column email text",
      verifyLogs: "all tests passed",
      builderReport: "build successful"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.message.includes("database/schema"))).toBe(true);
  });

  it("still treats migration file changes as high risk even with generic added lines", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update migration metadata",
      diff: "diff --git a/migrations/001.sql b/migrations/001.sql\n+-- backfill user metadata",
      verifyLogs: "all tests passed",
      builderReport: "Updated migration metadata."
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.message.includes("database/schema"))).toBe(true);
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
        "all tests passed\npreview banner is not configured in this fixture\npreview build is not configured in this fixture\nall verification passed; coverage threshold not configured",
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

  it("blocks when builder report says a configured verification command was not run", () => {
    const verdict = evaluateMinimalVerdict({
      task: "Update dashboard copy",
      diff: "diff --git a/dashboard.tsx b/dashboard.tsx\n+const title = 'Current usage'",
      verifyLogs: "all tests passed",
      builderReport: "pnpm schema:check was not run"
    });

    expect(verdict.verdict).toBe("block_pr");
    expect(verdict.must_fix.some((item) => item.source === "builder_report")).toBe(true);
  });
});
