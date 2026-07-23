import type {
  FindingSource,
  MinimalFinding,
  MinimalVerdict,
  RiskLevel,
  VerdictInput
} from "./types.js";

const AUTHORITATIVE_FAILURE_RESULT_PATTERNS = [
  /\b[1-9]\d*\s+(?:failures?|failed|errors?)\b/i,
  /\bexit code\s+(?:[1-9]\d*|null)\b/i,
  /\b(?:exited|returned) with (?:exit )?code\s+[1-9]\d*\b/i,
  /\b(?:timed out|terminated by signal|signal\s+SIG[A-Z]+)\b/i,
  /\bnpm ERR!/i,
  /\bERR_PNPM\b/i,
  /\bELIFECYCLE\b/i
];

const CLEAN_PASS_MARKER_PATTERN = /^(?:[^\w\s]+\s*)?(?:✓|✔|√|PASS\b|ok\b)\s+\S+/i;
const CLEAN_PASS_TEST_LINE_PATTERN =
  /^(?:[^\w\s]+\s*)?(?:(?:@?[\w.-]+\/[\w@./-]+\s+)?tests?:\s*)?(?:✓|✔|√)\s+\S+.*(?:\(|\s)\d+(?:\.\d+)?m?s\)?$/i;
const CLEAN_PASS_TEST_FILE_SUMMARY_PATTERN = /^(?:[^\w\s]+\s*)?(?:✓|✔|√)\s+\S+\s+\(\d+\s+tests?\)\s*(?:\d+(?:\.\d+)?m?s)?$/i;
const CLEAN_PASS_TEST_FILE_SUMMARY_FRAGMENT_PATTERN = /(?:^|\s)(?:✓|✔|√)\s+\S+\s+\(\d+\s+tests?\)\s*(?:\d+(?:\.\d+)?m?s)?(?:$|\s)/i;
const ZERO_SOFT_RISK_COUNT_PATTERN = /^(?:[^\w\s]+\s*)?(?:cancelled|skipped|todo)\s+0$/i;
const HARD_FAILURE_PATTERNS = [
  ...AUTHORITATIVE_FAILURE_RESULT_PATTERNS,
  /\b(?:tests?|checks?|build|typecheck|lint|schema(?::check)?|verification|command)\s+failed\b/i,
  /\bfailed\s+(?:tests?|checks?|build|typecheck|lint|schema(?::check)?|verification|command)\b/i,
  /\b(?:lint|typecheck|build|schema(?::check)?)\s+errors?\b/i,
  /^(?:FAIL|FAILED|FAILURE)\b/i,
  /^(?:×|✗|✘|❯)\s+\S/,
  /^(?:Error|Exception|panic):\s*\S/i,
  /^Traceback\b/i,
  /\bsegmentation fault\b/i,
  /\bnot mergeable\b/i
];

const PASSING_TEST_LINE_PATTERN = CLEAN_PASS_MARKER_PATTERN;

const CLEAN_RESULT_PATTERNS = [
  CLEAN_PASS_MARKER_PATTERN,
  /^(?:[^\w\s]+\s*)?0\s+(?:failures|failed|errors)$/i,
  /^(?:[^\w\s]+\s*)?errors?:\s*0$/i,
  /^(?:[^\w\s]+\s*)?found\s+0\s+errors?$/i,
  ZERO_SOFT_RISK_COUNT_PATTERN,
  /^(?:[^\w\s]+\s*)?no\s+(?:failures|errors)$/i,
  /^(?:[^\w\s]+\s*)?no\s+errors?\s+found$/i,
  /^(?:[^\w\s]+\s*)?all\s+(?:tests\s+)?passed$/i,
  /^(?:[^\w\s]+\s*)?(?:[\w:/.-]+\s+)*tests?\s+(?:ok|passed|succeeded|successful)$/i,
  /^(?:[^\w\s]+\s*)?build\s+(?:ok|passed|succeeded|successful)$/i,
  /^(?:[^\w\s]+\s*)?success(?:ful)?$/i,
  /\b\d+\s+passed\b.*\b0\s+(?:failures?|failed|errors?)\b/i,
  /\btest result:\s+ok\b.*\b0\s+(?:failures?|failed|errors?)\b/i,
  /\b\d+\s+problems?\s*\(\s*0\s+errors?,\s*\d+\s+warnings?\s*\)/i,
  /\b0\s+errors?,\s*\d+\s+warnings?\b/i
];

const EXPLICIT_FAILURE_RESULT_PATTERNS = HARD_FAILURE_PATTERNS;

const POSITIVE_VERIFICATION_PATTERNS = [
  /\[[xX]\]\s+\S+/,
  /^(?:[^\w\s]+\s*)?(?:✓|✔|√|PASS\b|ok\b)\s+\S+/im,
  /\bexit code 0\b/i,
  /\b0\s+(?:failures|failed|errors)\b/i,
  /\b0\s+errors?,\s*\d+\s+warnings?\b/i,
  /\bno\s+(?:failures|errors)\b/i,
  /\ball\s+(?:tests\s+)?passed\b/i,
  /\b\d+\s+passed\b/i,
  /\btests?\s+\d+\s+passed\b/i,
  /\btest files?\s+\d+\s+passed\b/i,
  /\bok\s+[\w./-]+\s+\d+(?:\.\d+)?s\b/i,
  /\b(?:build|typecheck|lint|tests?)\s+(?:ok|passed|succeeded|successful)\b/i
];

const SOFT_RISK_PATTERNS = [
  /\bwarn(?:ing)?s?\b/i,
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
  /\bnot executed\b/i
];

const MISSING_VERIFICATION_CONFIG_PATTERNS = [
  /\bverification commands are not configured\b/i,
  /\bno verification (?:logs|commands|results)\b/i,
  /\bverification\s+(?:commands?|logs?|results?)\s+(?:is|are|was|were)?\s*not configured\b/i,
  /\b(?:test|tests|typecheck|lint|schema(?::check)?)\s+(?:command\s+)?(?:is|are|was|were)?\s*not configured\b/i,
  /\bnot configured:?\s+(?:verification\s+(?:commands?|logs?|results?)|test|tests|typecheck|lint|schema(?::check)?)\b/i
];

const HIGH_RISK_DIFF_SIGNALS = [
  {
    label: "auth/authz",
    addedPattern:
      /\b(?:authz|authn)\s*\.|\b(?:authorize|authenticate)\w*\s*\(|\b(?:require|check|verify|enforce|assert)(?:Admin|Auth|Authorization|Authentication|Permission|Access|Role)\w*\s*\(|\b(?:auth|authorized|authorization|authentication|permission|permissions|role|policy|rbac|accessControl)\w*\s*(?:[=:]|[<>])|\bpermissionRank\s*\(/i,
    removedPattern:
      /\b(?:authz|authn)\s*\.|\b(?:authorize|authenticate)\w*\s*\(|\b(?:require|check|verify|enforce|assert)(?:Admin|Auth|Authorization|Authentication|Permission|Access|Role)\w*\s*\(|\b(?:auth|authorized|authorization|authentication|permission|permissions|role|policy|rbac|accessControl)\w*\s*(?:[=:]|[<>])|\bpermissionRank\s*\(/i,
    coveragePattern: /\b(?:admin|auth|authz|authn|authorization|authentication|guard|permission|role|access control|401|403|security)\b/i
  },
  {
    label: "secrets/credentials",
    addedPattern:
      /\b(?:const|let|var)\s+\w*(?:password|secret|token|credential|api_?key)\w*\s*=|\b(?:process\.env|req\.(?:body|headers)|headers\.get|secretManager|vault)\b[^\n]*(?:password|secret|token|credential|api[_-]?key)|\b(?:console|logger)\.\w+\s*\([^\n]*(?:password|secret|token|credential|api[_-]?key)/i,
    coveragePattern: /\b(?:secret|credential|token|api[_-\s]?key|redact|mask|leak|security)\b/i
  },
  {
    label: "billing/payments",
    addedPattern:
      /\b(?:stripe|paypal|paymentIntent|checkoutSession)\b|\b(?:payment|billing|invoice|checkout|refund|subscription)\w*\s*(?:\(|[=:])/i,
    removedPattern:
      /\b(?:stripe|paypal|paymentIntent|checkoutSession)\b|\b(?:payment|billing|invoice|checkout|refund|subscription)\w*\s*(?:\(|[=:])/i,
    pathPattern: /(?:^|\/)(?:billing|payments?|checkout|invoices?|refunds?|subscriptions?)(?:[./_-]|$)/i,
    coveragePattern: /\b(?:payment|billing|invoice|checkout|refund|subscription)\b/i
  },
  {
    label: "database/schema",
    addedPattern:
      /\b(?:alter|create|drop)\s+table\b|\b(?:db|database|prisma|sequelize|knex)\.(?:query|execute|transaction|migrate|schema)\b|\bmodel\s+\w+\s*\{/i,
    pathPattern: /\b(?:migration|migrations|schema\.sql|schema\.prisma)\b/i,
    coveragePattern:
      /\b(?:migration|migrations|database|sql|rollback|migrate|db\s+schema|database\s+schema|schema\s+migration|schema\.sql|schema\.prisma)\b/i
  },
  {
    label: "destructive data operation",
    addedPattern:
      /\b(?:drop\s+table|truncate|remove all|destroy)\b|\bdelete(?:[A-Z]\w*)?\s*\(|\bdelete\s+from\b|\bdeleteMany\s*\(|\bdeleteAll\s*\(/i,
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
  collectUnexecutedVerification("verify_logs", normalized.verifyLogs, mustFix, shouldFix);
  collectUnexecutedVerification("builder_report", normalized.builderReport, mustFix, shouldFix);
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
        message: `Diff touches high-risk ${diffRisk.label} code; targeted verification evidence was found, but reviewers should still inspect it.`,
        evidence: diffRisk.evidence
      });
    } else {
      mustFix.push({
        source: "diff",
        message: `Diff touches high-risk ${diffRisk.label} code. Run focused verification for this area before opening a PR.`,
        evidence: `${diffRisk.evidence}\nRemediation: Run focused verification for ${diffRisk.label} and report the results.`
      });
    }
  }

  const deduplicatedMustFix = deduplicateFindings(mustFix);
  const deduplicatedShouldFix = deduplicateFindings(shouldFix);

  const verdict = chooseVerdict({
    task: normalized.task,
    diff: normalized.diff,
    mustFix: deduplicatedMustFix,
    shouldFix: deduplicatedShouldFix,
    hasVerificationEvidence: hasPositiveVerificationEvidence(normalized.verifyLogs)
  });
  const risk = chooseRisk(verdict, deduplicatedMustFix, deduplicatedShouldFix, diffRisks.length > 0);
  const confidence = calculateConfidence(verdict, {
    task: normalized.task,
    diff: normalized.diff,
    verifyLogs: normalized.verifyLogs,
    builderReport: normalized.builderReport,
    mustFixCount: deduplicatedMustFix.length,
    shouldFixCount: deduplicatedShouldFix.length,
    highRiskDiff: diffRisks.length > 0,
    hasVerificationEvidence: hasPositiveVerificationEvidence(normalized.verifyLogs)
  });

  return {
    schemaVersion: 1,
    verdict,
    evidence_grade: "reported",
    must_fix: deduplicatedMustFix,
    should_fix: deduplicatedShouldFix,
    confidence,
    risk,
    summary: summarize(verdict, risk, deduplicatedMustFix.length, deduplicatedShouldFix.length)
  };
}

function collectUnexecutedVerification(
  source: FindingSource,
  text: string,
  mustFix: MinimalFinding[],
  shouldFix: MinimalFinding[]
): void {
  if (!text) return;
  for (const line of lines(text)) {
    if (isPassingTestLine(line)) continue;
    if (UNEXECUTED_VERIFICATION_PATTERNS.some((pattern) => pattern.test(line))) {
      mustFix.push({
        source,
        message: "Run the configured verification command and fix or report why it did not pass.",
        evidence: truncate(line)
      });
    } else if (MISSING_VERIFICATION_CONFIG_PATTERNS.some((pattern) => pattern.test(line))) {
      shouldFix.push({
        source,
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
    if (isPassingTestLine(line)) continue;
    if (isCleanResultLine(line)) continue;
    if (HARD_FAILURE_PATTERNS.some((pattern) => pattern.test(line))) {
      output.push({
        source,
        message: "Verification failed; rerun the reported command and fix the failing check.",
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
    if (isPassingTestLine(line)) continue;
    if (ZERO_SOFT_RISK_COUNT_PATTERN.test(line)) continue;
    const hasHardFailure =
      !isCleanResultLine(line) &&
      HARD_FAILURE_PATTERNS.some((pattern) => pattern.test(line));
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

function assessDiffRisk(diff: string): Array<{ label: string; evidence: string }> {
  if (!diff) return [];
  const changedLines = parseDiffRiskLines(diff).filter((line) => isRuntimeRiskLine(line));
  return HIGH_RISK_DIFF_SIGNALS.flatMap((signal) => {
    const matches = changedLines.filter((line) => {
      if (line.kind === "added" && signal.addedPattern.test(line.content)) return true;
      if (line.kind === "removed" && signal.removedPattern?.test(line.content)) return true;
      return Boolean(signal.pathPattern?.test(line.path));
    });
    if (matches.length === 0) return [];
    return [{
      label: signal.label,
      evidence: matches.slice(0, 3).map(formatDiffEvidence).join("\n")
    }];
  });
}

interface DiffRiskLine {
  kind: "added" | "removed";
  path: string;
  content: string;
}

function parseDiffRiskLines(diff: string): DiffRiskLine[] {
  const changedLines: DiffRiskLine[] = [];
  let currentPath = "unknown";

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentPath = match?.[2] ?? currentPath;
    } else if (line.startsWith("+++ b/")) {
      currentPath = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLines.push({ kind: "added", path: currentPath, content: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changedLines.push({ kind: "removed", path: currentPath, content: line.slice(1) });
    }
  }

  return changedLines;
}

function isRuntimeRiskLine(line: DiffRiskLine): boolean {
  if (/(?:^|\/)(?:docs?|test|tests|__tests__|fixtures?|eval\/corpus)(?:\/|$)/i.test(line.path)) {
    return false;
  }
  if (/\.(?:md|mdx|txt|snap)$/i.test(line.path) || /\.(?:test|spec)\.[^/]+$/i.test(line.path)) {
    return false;
  }
  const content = line.content.trim();
  if (!content) return false;
  return !/^(?:\/\/|#|\*|<!--)/.test(content);
}

function formatDiffEvidence(line: DiffRiskLine): string {
  const prefix = line.kind === "added" ? "+" : "-";
  return truncate(`${line.path}: ${prefix}${line.content.trim()}`);
}

function hasPositiveVerificationEvidence(verifyLogs: string): boolean {
  if (!verifyLogs) return false;
  const normalizedLines = lines(verifyLogs);
  const resultLines = normalizedLines.filter((line) => !isPassingTestLine(line));
  if (
    resultLines.some((line) =>
      UNEXECUTED_VERIFICATION_PATTERNS.some((pattern) => pattern.test(line)) ||
      MISSING_VERIFICATION_CONFIG_PATTERNS.some((pattern) => pattern.test(line))
    )
  ) {
    return false;
  }
  return normalizedLines.some((line) =>
    POSITIVE_VERIFICATION_PATTERNS.some((pattern) => pattern.test(line))
  );
}

function hasTargetedCoverage(
  label: string,
  verifyLogs: string,
  builderReport: string
): boolean {
  const signal = HIGH_RISK_DIFF_SIGNALS.find((candidate) => candidate.label === label);
  if (!signal) return false;
  return lines(`${verifyLogs}\n${builderReport}`).some((line) => {
    return (
      signal.coveragePattern.test(line) &&
      /\b(?:test|tested|verify|verified|coverage|passed|check|checked)\b/i.test(line)
    );
  });
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
  return stripTerminalFormatting(text.replace(/\r(?!\n)/g, "\n"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripTerminalFormatting(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
      ""
    )
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F-\u009F]/g, "");
}

function deduplicateFindings(findings: MinimalFinding[]): MinimalFinding[] {
  const seen = new Set<string>();
  const deduplicated: MinimalFinding[] = [];
  for (const finding of findings) {
    const sanitizedEvidence = finding.evidence
      ? stripTerminalFormatting(finding.evidence)
      : undefined;
    const normalizedEvidence = sanitizedEvidence
      ? sanitizedEvidence.replace(/\s+/g, " ").trim().toLowerCase()
      : "";
    const key = `${finding.message.toLowerCase()}\u0000${normalizedEvidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push({
      ...finding,
      ...(sanitizedEvidence ? { evidence: sanitizedEvidence } : {})
    });
  }
  return deduplicated;
}

function isCleanResultLine(line: string): boolean {
  const normalized = stripTerminalFormatting(line);
  if (CLEAN_PASS_TEST_LINE_PATTERN.test(normalized)) return true;
  if (CLEAN_PASS_TEST_FILE_SUMMARY_PATTERN.test(normalized)) return true;
  if (
    CLEAN_PASS_TEST_FILE_SUMMARY_FRAGMENT_PATTERN.test(normalized) &&
    !EXPLICIT_FAILURE_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }
  return (
    CLEAN_RESULT_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    !EXPLICIT_FAILURE_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function isPassingTestLine(line: string): boolean {
  const normalized = stripTerminalFormatting(line);
  if (CLEAN_PASS_TEST_LINE_PATTERN.test(normalized)) return true;
  if (CLEAN_PASS_TEST_FILE_SUMMARY_PATTERN.test(normalized)) return true;
  return (
    PASSING_TEST_LINE_PATTERN.test(normalized) &&
    !AUTHORITATIVE_FAILURE_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function truncate(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
