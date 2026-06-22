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

const SOFT_RISK_PATTERNS = [
  /\bwarn(?:ing)?\b/i,
  /\bflake|flaky\b/i,
  /\bskip(?:ped)?\b/i,
  /\btodo\b/i,
  /\bshould[-_\s]?fix\b/i,
  /\brisk\b/i,
  /\bmanual review\b/i
];

const HIGH_RISK_DIFF_PATTERNS = [
  /\b(?:auth|authorization|authentication|permission)\b/i,
  /\b(?:password|secret|token|credential)\b/i,
  /\b(?:payment|billing|invoice)\b/i,
  /\b(?:migration|schema|database)\b/i,
  /\b(?:delete|drop\s+table|truncate)\b/i
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
  }

  const diffRisk = assessDiffRisk(normalized.diff);
  if (diffRisk) shouldFix.push(diffRisk);

  const verdict = chooseVerdict({
    task: normalized.task,
    diff: normalized.diff,
    mustFix,
    shouldFix
  });
  const risk = chooseRisk(verdict, mustFix, shouldFix, diffRisk !== null);
  const confidence = calculateConfidence(verdict, {
    task: normalized.task,
    diff: normalized.diff,
    verifyLogs: normalized.verifyLogs,
    builderReport: normalized.builderReport,
    mustFixCount: mustFix.length,
    shouldFixCount: shouldFix.length,
    highRiskDiff: diffRisk !== null
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

function assessDiffRisk(diff: string): MinimalFinding | null {
  if (!diff) return null;
  if (HIGH_RISK_DIFF_PATTERNS.some((pattern) => pattern.test(diff))) {
    return {
      source: "diff",
      message:
        "Diff touches high-risk areas; keep this as should_fix unless verification explicitly covers it."
    };
  }
  return null;
}

function chooseVerdict(input: {
  task: string;
  diff: string;
  mustFix: MinimalFinding[];
  shouldFix: MinimalFinding[];
}): MinimalVerdict["verdict"] {
  if (input.mustFix.length > 0) return "block_pr";
  if (!input.task || !input.diff) return "needs_context";
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
