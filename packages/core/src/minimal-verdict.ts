import type {
  FindingSource,
  MinimalFinding,
  MinimalVerdict,
  RiskLevel,
  VerdictInput
} from "./types.js";

const HARD_FAILURE_PATTERNS = [
  /\bfailed?\b/i,
  /\bfailure\b/i,
  /\berror\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bpanic\b/i,
  /\bsegmentation fault\b/i,
  /\bexit code\s+[1-9]\d*\b/i,
  /\bnot mergeable\b/i,
  /\bblock(?:ed|ing|er)?\b/i,
  /\bmust[-_\s]?fix\b/i,
  /\bnpm ERR!\b/i,
  /\bERR_PNPM\b/i
];

const CLEAN_RESULT_PATTERNS = [
  /\b0\s+(?:failures|failed|errors)\b/i,
  /\bno\s+(?:failures|errors)\b/i,
  /\ball\s+(?:tests\s+)?passed\b/i,
  /\bbuild\s+(?:ok|passed|succeeded|successful)\b/i,
  /\bsuccess(?:ful)?\b/i
];

const POSITIVE_VERIFICATION_PATTERNS = [
  /\[[xX]\]\s+\S+/,
  /\bexit code 0\b/i,
  /\b0\s+(?:failures|failed|errors)\b/i,
  /\bno\s+(?:failures|errors)\b/i,
  /\ball\s+(?:tests\s+)?passed\b/i,
  /\b(?:build|typecheck|lint|tests?)\s+(?:ok|passed|succeeded|successful)\b/i
];

const SOFT_RISK_PATTERNS = [
  /\bwarn(?:ing)?\b/i,
  /\bflake|flaky\b/i,
  /\bskip(?:ped)?\b/i,
  /\btodo\b/i,
  /\bshould[-_\s]?fix\b/i,
  /\brisk\b/i,
  /\bmanual review\b/i
];

const UNEXECUTED_VERIFICATION_PATTERNS = [
  /\[\s\]\s+\S+/,
  /\b(?:was\s+)?not run\b/i,
  /\bnot executed\b/i,
  /\bskipped because\b/i
];

const MISSING_VERIFICATION_CONFIG_PATTERNS = [
  /\bverification commands are not configured\b/i,
  /\bno verification (?:logs|commands|results)\b/i,
  /\bnot configured\b/i
];

const HIGH_RISK_DIFF_SIGNALS = [
  {
    label: "auth/authz",
    diffPattern: /\b(?:auth|authz|authn|authorization|authentication|permission|access control)\b/i,
    coveragePattern: /\b(?:auth|authz|authn|authorization|authentication|permission|access control|401|403|security)\b/i
  },
  {
    label: "secrets/credentials",
    diffPattern: /\b(?:password|secret|token|credential|api[_-\s]?key)\b/i,
    coveragePattern: /\b(?:secret|credential|token|api[_-\s]?key|redact|mask|leak|security)\b/i
  },
  {
    label: "billing/payments",
    diffPattern: /\b(?:payment|billing|invoice|checkout|refund|subscription)\b/i,
    coveragePattern: /\b(?:payment|billing|invoice|checkout|refund|subscription)\b/i
  },
  {
    label: "database/schema",
    diffPattern: /\b(?:migration|schema|database|sql|alter table|create table)\b/i,
    coveragePattern: /\b(?:migration|schema|database|sql|rollback|migrate)\b/i
  },
  {
    label: "destructive data operation",
    diffPattern: /\b(?:delete|drop\s+table|truncate|remove all|destroy)\b/i,
    coveragePattern: /\b(?:delete|drop\s+table|truncate|data loss|backup|rollback|destructive)\b/i
  }
];

export function evaluateMinimalVerdict(input: VerdictInput): MinimalVerdict {
  const normalized = {
    task: input.task.trim(),
    diff: input.diff.trim(),
    verifyLogs: input.verifyLogs.trim(),
    builderReport: input.builderReport.trim()
  };

  const mustFix: MinimalFinding[] = [];
  const shouldFix: MinimalFinding[] = [];

  collectHardFailures("verify_logs", normalized.verifyLogs, mustFix);
  collectHardFailures("builder_report", normalized.builderReport, mustFix);
  collectUnexecutedVerification(normalized.verifyLogs, mustFix, shouldFix);
  collectSoftRisks("verify_logs", normalized.verifyLogs, shouldFix);
  collectSoftRisks("builder_report", normalized.builderReport, shouldFix);

  if (!normalized.task) {
    shouldFix.push({
      source: "task",
      message: "Task is missing, so the diff cannot be checked against intent."
    });
  }
  if (!normalized.diff) {
    shouldFix.push({
      source: "diff",
      message: "Diff is missing, so only logs/report can be assessed."
    });
  }
  if (!normalized.verifyLogs && !normalized.builderReport) {
    shouldFix.push({
      source: "system",
      message: "No verification logs or builder report were provided."
    });
  } else if (!hasPositiveVerificationEvidence(normalized.verifyLogs)) {
    shouldFix.push({
      source: "verify_logs",
      message: "No positive mechanical verification evidence was provided."
    });
  }

  const diffRisks = assessDiffRisk(normalized.diff);
  for (const diffRisk of diffRisks) {
    if (hasTargetedCoverage(diffRisk.label, normalized.verifyLogs, normalized.builderReport)) {
      shouldFix.push({
        source: "diff",
        message: `Diff touches high-risk ${diffRisk.label} code; targeted verification evidence was found, but reviewers should still inspect it.`
      });
    } else {
      mustFix.push({
        source: "diff",
        message: `Diff touches high-risk ${diffRisk.label} code without targeted verification evidence.`,
        evidence: "Add or report focused verification for this high-risk area before opening a PR."
      });
    }
  }

  const verdict = chooseVerdict({
    task: normalized.task,
    diff: normalized.diff,
    mustFix,
    shouldFix,
    hasVerificationEvidence: hasPositiveVerificationEvidence(normalized.verifyLogs)
  });
  const risk = chooseRisk(verdict, mustFix, shouldFix, diffRisks.length > 0);
  const confidence = calculateConfidence(verdict, {
    task: normalized.task,
    diff: normalized.diff,
    verifyLogs: normalized.verifyLogs,
    builderReport: normalized.builderReport,
    mustFixCount: mustFix.length,
    shouldFixCount: shouldFix.length,
    highRiskDiff: diffRisks.length > 0,
    hasVerificationEvidence: hasPositiveVerificationEvidence(normalized.verifyLogs)
  });

  return {
    schemaVersion: 1,
    verdict,
    must_fix: mustFix,
    should_fix: shouldFix,
    confidence,
    risk,
    summary: summarize(verdict, risk, mustFix.length, shouldFix.length)
  };
}

function collectUnexecutedVerification(
  text: string,
  mustFix: MinimalFinding[],
  shouldFix: MinimalFinding[]
): void {
  if (!text) return;
  for (const line of lines(text)) {
    if (UNEXECUTED_VERIFICATION_PATTERNS.some((pattern) => pattern.test(line))) {
      mustFix.push({
        source: "verify_logs",
        message: "A configured verification command did not pass.",
        evidence: truncate(line)
      });
    } else if (MISSING_VERIFICATION_CONFIG_PATTERNS.some((pattern) => pattern.test(line))) {
      shouldFix.push({
        source: "verify_logs",
        message: "Mechanical verification was not configured or not executed.",
        evidence: truncate(line)
      });
    }
  }
}

function collectHardFailures(
  source: FindingSource,
  text: string,
  output: MinimalFinding[]
): void {
  if (!text) return;
  for (const line of lines(text)) {
    if (isCleanResultLine(line)) continue;
    if (HARD_FAILURE_PATTERNS.some((pattern) => pattern.test(line))) {
      output.push({
        source,
        message: "Verification output contains a blocking failure.",
        evidence: truncate(line)
      });
    }
  }
}

function collectSoftRisks(
  source: FindingSource,
  text: string,
  output: MinimalFinding[]
): void {
  if (!text) return;
  for (const line of lines(text)) {
    const hasHardFailure = HARD_FAILURE_PATTERNS.some((pattern) => pattern.test(line));
    if (hasHardFailure) continue;
    if (SOFT_RISK_PATTERNS.some((pattern) => pattern.test(line))) {
      output.push({
        source,
        message: "Verification output contains a non-blocking risk signal.",
        evidence: truncate(line)
      });
    }
  }
}

function assessDiffRisk(diff: string): Array<{ label: string }> {
  if (!diff) return [];
  return HIGH_RISK_DIFF_SIGNALS.filter((signal) => signal.diffPattern.test(diff)).map((signal) => ({
    label: signal.label
  }));
}

function hasPositiveVerificationEvidence(verifyLogs: string): boolean {
  if (!verifyLogs) return false;
  if (
    UNEXECUTED_VERIFICATION_PATTERNS.some((pattern) => pattern.test(verifyLogs)) ||
    MISSING_VERIFICATION_CONFIG_PATTERNS.some((pattern) => pattern.test(verifyLogs))
  ) {
    return false;
  }
  return POSITIVE_VERIFICATION_PATTERNS.some((pattern) => pattern.test(verifyLogs));
}

function hasTargetedCoverage(
  label: string,
  verifyLogs: string,
  builderReport: string
): boolean {
  const signal = HIGH_RISK_DIFF_SIGNALS.find((candidate) => candidate.label === label);
  if (!signal) return false;
  const evidenceText = `${verifyLogs}\n${builderReport}`;
  if (!signal.coveragePattern.test(evidenceText)) return false;
  return /\b(?:test|tested|verify|verified|coverage|passed|check|checked)\b/i.test(evidenceText);
}

function chooseVerdict(input: {
  task: string;
  diff: string;
  mustFix: MinimalFinding[];
  shouldFix: MinimalFinding[];
  hasVerificationEvidence: boolean;
}): MinimalVerdict["verdict"] {
  if (input.mustFix.length > 0) return "block_pr";
  if (!input.task || !input.diff) return "needs_context";
  if (!input.hasVerificationEvidence) return "needs_context";
  if (input.shouldFix.length > 0) return "open_pr_with_warning";
  return "open_pr";
}

function chooseRisk(
  verdict: MinimalVerdict["verdict"],
  mustFix: MinimalFinding[],
  shouldFix: MinimalFinding[],
  highRiskDiff: boolean
): RiskLevel {
  if (verdict === "block_pr" || mustFix.length >= 2) return "high";
  if (highRiskDiff || shouldFix.length >= 2 || verdict === "needs_context") return "medium";
  if (verdict === "open_pr_with_warning") return "medium";
  return "low";
}

function calculateConfidence(
  verdict: MinimalVerdict["verdict"],
  input: {
    task: string;
    diff: string;
    verifyLogs: string;
    builderReport: string;
    mustFixCount: number;
    shouldFixCount: number;
    highRiskDiff: boolean;
    hasVerificationEvidence: boolean;
  }
): number {
  let confidence =
    verdict === "block_pr"
      ? 78
      : verdict === "open_pr"
        ? 82
        : verdict === "open_pr_with_warning"
          ? 68
          : 55;
  if (!input.task) confidence -= 12;
  if (!input.diff) confidence -= 12;
  if (!input.verifyLogs) confidence -= 8;
  if (!input.builderReport) confidence -= 6;
  if (!input.hasVerificationEvidence) confidence -= 16;
  confidence -= Math.min(input.shouldFixCount * 4, 20);
  if (input.highRiskDiff) confidence -= 8;
  if (input.mustFixCount > 0) confidence += Math.min(input.mustFixCount * 3, 9);
  return clamp(Math.round(confidence), 0, 100);
}

function summarize(
  verdict: MinimalVerdict["verdict"],
  risk: RiskLevel,
  mustFixCount: number,
  shouldFixCount: number
): string {
  if (verdict === "block_pr") {
    return `Block PR with ${mustFixCount} must_fix item(s); risk is ${risk}.`;
  }
  if (verdict === "needs_context") {
    return `Needs context with ${shouldFixCount} should_fix item(s); risk is ${risk}.`;
  }
  if (verdict === "open_pr_with_warning") {
    return `Open PR with warning and ${shouldFixCount} should_fix item(s); risk is ${risk}.`;
  }
  return `Open PR with ${shouldFixCount} should_fix item(s); risk is ${risk}.`;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isCleanResultLine(line: string): boolean {
  return CLEAN_RESULT_PATTERNS.some((pattern) => pattern.test(line));
}

function truncate(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
