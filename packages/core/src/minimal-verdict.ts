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
const CLEAN_PASS_TEST_LINE_PATTERN = /^(?:[^\w\s]+\s*)?(?:✓|✔|√)\s+\S+.*\(\d+(?:\.\d+)?m?s\)$/i;
const CLEAN_PREFIXED_PASS_TEST_LINE_PATTERN =
  /^(?:[^\w\s]+\s*)?(?:@?[\w.-]+\/[\w@./-]+\s+)?tests?:\s*(?:✓|✔|√)\s+\S+.*\s\d+(?:\.\d+)?m?s$/i;
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

const SECRET_GUARD_ACTION = String.raw`(?:redact|mask|saniti[sz](?:e|ation)|scrub)`;
const SECRET_GUARD_TARGET = String.raw`(?:password|secret|token|credential|api[_-]?key|auth(?:orization)?|headers?|cookies?)`;
const SECRET_TARGET_PATTERNS = [
  { name: "password", pattern: /\bpasswords?\b/i },
  { name: "secret", pattern: /\bsecrets?\b/i },
  { name: "token", pattern: /\btokens?\b/i },
  { name: "credential", pattern: /\bcredentials?\b/i },
  { name: "api-key", pattern: /\bapi[_\-\s]?keys?\b/i },
  { name: "authorization", pattern: /\bauth(?:orization)?\b/i },
  { name: "header", pattern: /\bheaders?\b/i },
  { name: "cookie", pattern: /\bcookies?\b/i }
] as const;
const REMOVED_SECRET_GUARD_PATTERN = new RegExp(
  String.raw`\b(?:${SECRET_GUARD_ACTION}\w*${SECRET_GUARD_TARGET}\w*|${SECRET_GUARD_TARGET}\w*${SECRET_GUARD_ACTION}\w*)\b|\b${SECRET_GUARD_ACTION}\w*\s*\([^\n]*${SECRET_GUARD_TARGET}|\b${SECRET_GUARD_ACTION}\w*\s*:\s*[^\n]*${SECRET_GUARD_TARGET}`,
  "i"
);

const HIGH_RISK_DIFF_SIGNALS = [
  {
    label: "auth/authz",
    addedPattern:
      /\b(?:authz|authn)\s*\.|\b(?:authorize|authenticate)\w*\s*\(|\b(?:require|check|verify|enforce|assert)(?:Admin|Auth|Authorization|Authentication|Permission|Access|Role)\w*\s*\(|\b(?:auth|authorized|authorization|authentication|permission|permissions|role|rbac|accessControl)\w*\s*(?:[=:]|[<>])|\bpermissionRank\s*\(/i,
    removedPattern:
      /\b(?:authz|authn)\s*\.|\b(?:authorize|authenticate)\w*\s*\(|\b(?:require|check|verify|enforce|assert)(?:Admin|Auth|Authorization|Authentication|Permission|Access|Role)\w*\s*\(|\b(?:auth|authorized|authorization|authentication|permission|permissions|role|rbac|accessControl)\w*\s*(?:[=:]|[<>])|\bpermissionRank\s*\(/i,
    coveragePattern: /\b(?:admin|auth|authz|authn|authorization|authentication|guard|permission|role|access control|401|403|security)\b/i
  },
  {
    label: "secrets/credentials",
    addedPattern:
      /\b(?:const|let|var)\s+\w*(?:password|secret|token|credential|api_?key)\w*\s*=|\b(?:process\.env|req\.(?:body|headers)|headers\.get|secretManager|vault)\b[^\n]*(?:password|secret|token|credential|api[_-]?key)|\b(?:console|logger)\.\w+\s*\([^\n]*(?:password|secret|token|credential|api[_-]?key)/i,
    removedPattern: REMOVED_SECRET_GUARD_PATTERN,
    coveragePattern:
      /\b(?:password|secret|credential|token|api[_-\s]?key|redact|mask|saniti[sz](?:e|ation)|scrub|headers?|cookies?|auth(?:orization)?|leak|security)\b/i
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
    if (hasTargetedCoverage(diffRisk.label, diffRisk.coverageTargets, normalized.verifyLogs, normalized.builderReport)) {
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

function assessDiffRisk(diff: string): Array<{ label: string; evidence: string; coverageTargets: string[] }> {
  if (!diff) return [];
  const allDiffLines = parseDiffRiskLines(diff);
  const diffLines = allDiffLines.filter((line) => isRuntimeRiskLine(line));
  const authorizationPolicyMatches = findAuthorizationPolicyMatches(allDiffLines)
    .filter((line) => isRuntimeRiskLine(line));
  return HIGH_RISK_DIFF_SIGNALS.flatMap((signal) => {
    const matches = diffLines.filter((line, index) => {
      if (line.kind === "added" && signal.addedPattern.test(line.content)) return true;
      if (line.kind === "removed" && signal.removedPattern?.test(line.content)) return true;
      return line.kind !== "context" && Boolean(signal.pathPattern?.test(line.path));
    });
    if (signal.removedPattern) {
      for (const line of findMultilineRemovedMatches(allDiffLines, signal.removedPattern)) {
        if (!matches.some((match) => match.path === line.path && match.hunk === line.hunk && match.content === line.content)) {
          matches.push(line);
        }
      }
    }
    if (signal.label === "auth/authz") {
      for (const line of authorizationPolicyMatches) {
        if (!matches.includes(line)) matches.push(line);
      }
    }
    if (matches.length === 0) return [];
    return [{
      label: signal.label,
      evidence: matches.slice(0, 3).map(formatDiffEvidence).join("\n"),
      coverageTargets: signal.label === "secrets/credentials"
        ? extractSecretTargets(matches)
        : []
    }];
  });
}

function findMultilineRemovedMatches(lines: DiffRiskLine[], pattern: RegExp): DiffRiskLine[] {
  const matches: DiffRiskLine[] = [];
  let group: DiffRiskLine[] = [];
  const flush = () => {
    const first = group[0];
    if (first && group.length > 1) {
      const content = group.map((line) => line.content.trim()).join(" ");
      if (pattern.test(content)) matches.push({ ...first, content });
    }
    group = [];
  };

  for (const line of lines) {
    const previous = group.at(-1);
    if (previous && removedExpressionIsComplete(group)) flush();
    if (
      line.kind !== "removed" ||
      !isRuntimeRiskLine(line) ||
      (previous && (previous.path !== line.path || previous.hunk !== line.hunk))
    ) {
      flush();
      if (line.kind !== "removed" || !isRuntimeRiskLine(line)) continue;
    }
    group.push(line);
  }
  flush();
  return matches;
}

function removedExpressionIsComplete(group: DiffRiskLine[]): boolean {
  const content = group.map((line) => line.content.trim()).join("\n");
  const scanned = scanDelimiterCode(content);
  if (scanned.depth > 0) return false;
  return !/(?:[=,:.]|=>|\b(?:return|throw))\s*$/.test(scanned.content);
}

function scanDelimiterCode(content: string): { content: string; depth: number } {
  const output = content.split("");
  let depth = 0;
  let quote = "";
  let blockComment = false;
  const templateExpressionDepths: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (blockComment) {
      output[index] = " ";
      if (character === "*" && next === "/") {
        output[index + 1] = " ";
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output[index] = " ";
      if (character === "\\") {
        index += 1;
        if (index < content.length) output[index] = " ";
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    const templateDepth = templateExpressionDepths.at(-1);
    if (templateDepth === 0) {
      output[index] = " ";
      if (character === "\\") {
        index += 1;
        if (index < content.length) output[index] = " ";
      } else if (character === "`") {
        templateExpressionDepths.pop();
      } else if (character === "$" && next === "{") {
        output[index + 1] = " ";
        templateExpressionDepths[templateExpressionDepths.length - 1] = 1;
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") {
        output[index] = " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const computedPropertyEnd = findComputedPropertyLiteralEnd(content, output, index);
      if (computedPropertyEnd >= 0) {
        output[index] = " ";
        output[computedPropertyEnd] = " ";
        index = computedPropertyEnd;
        continue;
      }
      quote = character;
      output[index] = " ";
      continue;
    }
    if (character === "/" && isRegexLiteralStart(content, index)) {
      const end = findRegexLiteralEnd(content, index);
      for (let masked = index; masked <= end; masked += 1) output[masked] = " ";
      index = end;
      continue;
    }
    if (character === "`") {
      templateExpressionDepths.push(0);
      output[index] = " ";
      continue;
    }
    if (templateDepth !== undefined) {
      if (character === "{") {
        templateExpressionDepths[templateExpressionDepths.length - 1] = templateDepth + 1;
      } else if (character === "}") {
        const nextDepth = templateDepth - 1;
        templateExpressionDepths[templateExpressionDepths.length - 1] = nextDepth;
        if (nextDepth === 0) {
          output[index] = " ";
          continue;
        }
      }
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
  }
  return { content: output.join(""), depth };
}

function findComputedPropertyLiteralEnd(
  content: string,
  output: string[],
  quoteIndex: number
): number {
  let bracketIndex = quoteIndex - 1;
  while (bracketIndex >= 0 && /\s/.test(output[bracketIndex] ?? "")) bracketIndex -= 1;
  if (output[bracketIndex] !== "[") return -1;

  let receiverIndex = bracketIndex - 1;
  while (receiverIndex >= 0 && /\s/.test(output[receiverIndex] ?? "")) receiverIndex -= 1;
  if (!/[\w$\]).]/.test(output[receiverIndex] ?? "")) return -1;

  const quote = content[quoteIndex] ?? "";
  let closingQuote = quoteIndex + 1;
  for (; closingQuote < content.length; closingQuote += 1) {
    const character = content[closingQuote] ?? "";
    if (character === "\\") {
      closingQuote += 1;
    } else if (character === quote) {
      break;
    }
  }
  if (closingQuote >= content.length) return -1;

  let closingBracket = closingQuote + 1;
  while (closingBracket < content.length && /\s/.test(content[closingBracket] ?? "")) {
    closingBracket += 1;
  }
  return content[closingBracket] === "]" ? closingQuote : -1;
}

function findAuthorizationPolicyMatches(lines: DiffRiskLine[]): DiffRiskLine[] {
  const matches: DiffRiskLine[] = [];
  const executableLines = findExecutableCodeLines(lines);
  for (const [index, line] of lines.entries()) {
    for (const side of sidesForLine(line)) {
      const lineContent = executableLines[side].get(line) ?? "";
      const policyProperty = parsePolicyProperty(lineContent);
      if (!policyProperty) continue;

      const policyIndent = policyProperty.indent;
      const policyValue = /\.ya?ml$/i.test(line.path)
        ? stripYamlNodeProperties(stripYamlComment(policyProperty.value))
        : policyProperty.value;
      const structuredOpener = getUnterminatedStructure(policyValue);
      const blockScalar = /^[|>][-+]?\d*$/.test(policyValue);
      const scalarValue = structuredOpener || blockScalar ? "" : policyValue;
      const authPath = isAuthorizationPath(line.path);
      if (scalarValue) {
        if ((authPath || isAuthorizationPolicyValue(scalarValue)) && line.kind !== "context") {
          if (!matches.includes(line)) matches.push(line);
        }
        continue;
      }
      const blockLines: DiffRiskLine[] = [];
      let structuredValue = policyValue;
      for (const candidate of lines.slice(index + 1)) {
        if (candidate.path !== line.path || candidate.hunk !== line.hunk) break;
        if (candidate.kind !== "context" && candidate.kind !== side) continue;
        const candidateContent = executableLines[side].get(candidate) ?? "";
        if (structuredOpener) {
          blockLines.push(candidate);
          structuredValue += `\n${candidateContent}`;
          if (!getUnterminatedStructure(structuredValue)) break;
          continue;
        }
        const candidateIndent = /^\s*/.exec(candidate.content)?.[0].length ?? 0;
        if (candidateIndent <= policyIndent) break;
        blockLines.push(candidate);
      }
      const blockContents = [
        structuredOpener ? policyValue.slice(1).trim() : "",
        ...blockLines
          .map((candidate) =>
            blockScalar ? candidate.content : (executableLines[side].get(candidate) ?? "")
          )
      ].filter(Boolean);
      const isAuthorizationBlock =
        authPath ||
        (structuredOpener === "["
          ? blockContents.some((content) => isAuthorizationPolicyValue(content))
          : (
              blockContents.some((content) =>
                /(?:^|[{,])\s*(?:-\s*)?["']?effect["']?\s*:\s*["']?(?:allow|deny)\b/i.test(content)
              ) &&
              blockContents.some((content) =>
                /(?:^|[{,])\s*(?:-\s*)?["']?(?:principals?|subjects?|roles?|permissions?|resources?|actions?)["']?\s*:/i.test(content)
              )
            ));
      if (!isAuthorizationBlock) continue;
      for (const candidate of [line, ...blockLines]) {
        if (candidate.kind === side && !matches.includes(candidate)) matches.push(candidate);
      }
    }
  }
  return matches;
}

interface CodeScanState {
  blockComment: boolean;
  templateExpressionDepths: number[];
}

function findExecutableCodeLines(lines: DiffRiskLine[]): Record<DiffSide, Map<DiffRiskLine, string>> {
  const executableLines = {
    added: new Map<DiffRiskLine, string>(),
    removed: new Map<DiffRiskLine, string>()
  };
  const codeStates = new Map<string, CodeScanState>();
  const yamlScalarIndents = new Map<string, number | null>();
  for (const line of lines) {
    for (const side of sidesForLine(line)) {
      const key = `${line.path}\0${line.hunk}\0${side}`;
      if (/\.(?:[cm]?[jt]sx?)$/i.test(line.path)) {
        const state = codeStates.get(key) ?? {
          blockComment: false,
          templateExpressionDepths: []
        };
        const scanned = scanExecutableCode(line.content, state);
        executableLines[side].set(line, scanned.content);
        codeStates.set(key, scanned.state);
      } else if (/\.ya?ml$/i.test(line.path)) {
        const indent = /^\s*/.exec(line.content)?.[0].length ?? 0;
        const isBlank = line.content.trim().length === 0;
        let scalarIndent = yamlScalarIndents.get(key) ?? null;
        if (scalarIndent !== null && !isBlank && indent <= scalarIndent) scalarIndent = null;
        executableLines[side].set(line, scalarIndent === null ? line.content : "");
        if (/:\s*[|>][-+]?\d*(?:\s+#.*)?$/.test(line.content)) scalarIndent = indent;
        yamlScalarIndents.set(key, scalarIndent);
      } else {
        executableLines[side].set(line, line.content);
      }
    }
  }
  return executableLines;
}

function sidesForLine(line: DiffRiskLine): DiffSide[] {
  return line.kind === "context" ? ["added", "removed"] : [line.kind];
}

function scanExecutableCode(
  content: string,
  initial: CodeScanState
): { content: string; state: CodeScanState } {
  let blockComment = initial.blockComment;
  const templateExpressionDepths = [...initial.templateExpressionDepths];
  const output = [...content].map(() => " ");
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    const templateDepth = templateExpressionDepths.at(-1);
    if (templateDepth === 0) {
      if (character === "\\") {
        index += 1;
      } else if (character === "`") {
        templateExpressionDepths.pop();
      } else if (character === "$" && next === "{") {
        templateExpressionDepths[templateExpressionDepths.length - 1] = 1;
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "/") break;
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      output[index] = character;
      for (index += 1; index < content.length; index += 1) {
        const quotedCharacter = content[index] ?? "";
        output[index] = quotedCharacter;
        if (quotedCharacter === "\\") {
          index += 1;
          if (index < content.length) output[index] = content[index] ?? "";
        } else if (quotedCharacter === quote) {
          break;
        }
      }
      continue;
    }
    if (character === "/" && isRegexLiteralStart(content, index)) {
      index = findRegexLiteralEnd(content, index);
      continue;
    }
    if (character === "`") {
      templateExpressionDepths.push(0);
      continue;
    }
    if (templateDepth !== undefined) {
      if (character === "{") {
        templateExpressionDepths[templateExpressionDepths.length - 1] = templateDepth + 1;
      } else if (character === "}") {
        const nextDepth = templateDepth - 1;
        templateExpressionDepths[templateExpressionDepths.length - 1] = nextDepth;
        if (nextDepth === 0) continue;
      }
    }
    output[index] = character;
  }
  return {
    content: output.join(""),
    state: { blockComment, templateExpressionDepths }
  };
}

function parsePolicyProperty(content: string): { indent: number; value: string; inline: boolean } | null {
  const leading = /^(\s*)(?:-\s*)?(?:(["'])policy\2|policy)\s*[:=]\s*/i.exec(content);
  if (leading) {
    return {
      indent: leading[1]?.length ?? 0,
      value: extractPropertyValue(content.slice(leading[0].length)),
      inline: false
    };
  }
  const inlineValueStart = findInlinePolicyValueStart(content);
  if (inlineValueStart === null) return null;
  return {
    indent: /^\s*/.exec(content)?.[0].length ?? 0,
    value: extractPropertyValue(content.slice(inlineValueStart)),
    inline: true
  };
}

function findInlinePolicyValueStart(content: string): number | null {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && content[index + 1] === "/") return null;
    if (character === "/" && content[index + 1] === "*") {
      const end = content.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    if (character === "/" && isRegexLiteralStart(content, index)) {
      index = findRegexLiteralEnd(content, index);
      continue;
    }
    const assignment = /^(?:(?:const|let|var)\s+policy(?:\s*:\s*[^=]+)?|(?:[A-Za-z_$][\w$]*\.)+policy)\s*=\s*/i.exec(
      content.slice(index)
    );
    const hasTokenBoundary = index === 0 || !/[\w$]/.test(content[index - 1] ?? "");
    if (assignment && hasTokenBoundary) return index + assignment[0].length;
    if (character !== "{" && character !== ",") continue;
    const property = /^[{,]\s*(?:(["'])policy\1|policy)\s*[:=]\s*/i.exec(content.slice(index));
    if (property) return index + property[0].length;
  }
  return null;
}

function isRegexLiteralStart(content: string, index: number): boolean {
  const prefix = content.slice(0, index).trimEnd();
  return (
    prefix.length === 0 ||
    /[=>(:,!&|?;[\]{}]$/.test(prefix) ||
    /(?:^|[^\w$])(?:return|throw|case|yield|await)\s*$/i.test(prefix)
  );
}

function findRegexLiteralEnd(content: string, start: number): number {
  let escaped = false;
  let characterClass = false;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index] ?? "";
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "[") {
      characterClass = true;
    } else if (character === "]") {
      characterClass = false;
    } else if (character === "/" && !characterClass) {
      return index;
    }
  }
  return content.length - 1;
}

function stripYamlComment(value: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return value.slice(0, index).trim();
    }
  }
  return value;
}

function stripYamlNodeProperties(value: string): string {
  return value.replace(/^(?:(?:&[\w.-]+|![^\s,[\]{}]+)\s*)+/, "").trim();
}

function extractPropertyValue(input: string): string {
  let quote = "";
  let escaped = false;
  let depth = 0;
  let end = input.length;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      if (depth === 0) {
        end = index;
        break;
      }
      depth -= 1;
    } else if (character === "," && depth === 0) {
      end = index;
      break;
    }
  }
  return input.slice(0, end).trim();
}

function getUnterminatedStructure(value: string): "{" | "[" | "" {
  const opener = value[0];
  if (opener !== "{" && opener !== "[") return "";
  const stack: string[] = [];
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" && stack.at(-1) === "{") {
      stack.pop();
    } else if (character === "]" && stack.at(-1) === "[") {
      stack.pop();
    }
  }
  return stack.length > 0 ? opener : "";
}

function isAuthorizationPath(path: string): boolean {
  return /(?:^|[/_.-])(?:auth|authz|authn|authorization|permissions?|rbac|iam|access[-_]?control|security)(?:[/_.-]|$)/i.test(path);
}

function isAuthorizationPolicyValue(value: string): boolean {
  const normalized = value.replace(/^["']|["'],?$/g, "");
  const tokens = normalized.match(/[A-Z]+(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+/g) ?? [];
  const authorizationTokens = new Set([
    "admin",
    "owner",
    "auth",
    "authn",
    "authz",
    "authorization",
    "permission",
    "permissions",
    "role",
    "roles",
    "rbac",
    "mfa"
  ]);
  return (
    tokens.some((token) => authorizationTokens.has(token.toLowerCase())) ||
    /(?:^|[^A-Za-z])(?:access|allow|deny)(?:$|[^A-Za-z])/i.test(normalized) ||
    /^(?:can|require|must)[A-Z_]/.test(normalized)
  );
}

interface DiffRiskLine {
  kind: "added" | "removed" | "context";
  path: string;
  content: string;
  hunk: number;
}

type DiffSide = Exclude<DiffRiskLine["kind"], "context">;

function parseDiffRiskLines(diff: string): DiffRiskLine[] {
  const changedLines: DiffRiskLine[] = [];
  let currentPath = "unknown";
  let inHunk = false;
  let hunk = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentPath = match?.[2] ?? currentPath;
      inHunk = false;
    } else if (line.startsWith("+++ b/")) {
      currentPath = line.slice(6);
    } else if (line.startsWith("@@")) {
      inHunk = true;
      hunk += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLines.push({ kind: "added", path: currentPath, content: line.slice(1), hunk });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changedLines.push({ kind: "removed", path: currentPath, content: line.slice(1), hunk });
    } else if (inHunk && line.startsWith(" ")) {
      changedLines.push({ kind: "context", path: currentPath, content: line.slice(1), hunk });
    }
  }

  return changedLines;
}

function isRuntimeRiskLine(line: DiffRiskLine): boolean {
  if (/(?:^|\/)(?:docs?|test|tests|__tests__|fixtures?|eval\/corpus)(?:\/|$)/i.test(line.path)) {
    return false;
  }
  if (
    /\.(?:md|mdx|txt|snap)$/i.test(line.path) ||
    /\.(?:test|spec)\.[^/]+$/i.test(line.path) ||
    /(?:^|\/)(?:test|spec)-[^/]+\.sh$/i.test(line.path)
  ) {
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
  return normalizedLines.some(
    (line) =>
      POSITIVE_VERIFICATION_PATTERNS.some((pattern) => pattern.test(line)) ||
      (CLEAN_PREFIXED_PASS_TEST_LINE_PATTERN.test(line) &&
        !AUTHORITATIVE_FAILURE_RESULT_PATTERNS.some((pattern) => pattern.test(line)))
  );
}

function hasTargetedCoverage(
  label: string,
  coverageTargets: string[],
  verifyLogs: string,
  builderReport: string
): boolean {
  const signal = HIGH_RISK_DIFF_SIGNALS.find((candidate) => candidate.label === label);
  if (!signal) return false;
  const coverageLines = lines(`${verifyLogs}\n${builderReport}`).filter((line) => {
    return (
      signal.coveragePattern.test(line) &&
      /\b(?:test|tested|verify|verified|coverage|passed|check|checked)\b/i.test(line)
    );
  });
  if (label !== "secrets/credentials") return coverageLines.length > 0;
  if (coverageTargets.length === 0) return false;
  return coverageTargets.every((target) => {
    const targetPattern = SECRET_TARGET_PATTERNS.find((candidate) => candidate.name === target)?.pattern;
    return Boolean(targetPattern && coverageLines.some((line) => targetPattern.test(line)));
  });
}

function extractSecretTargets(matches: DiffRiskLine[]): string[] {
  const executableContent = matches
    .flatMap(({ content, path }) => extractSecretTargetContent(content, path))
    .join("\n");
  return SECRET_TARGET_PATTERNS
    .filter(({ pattern }) => pattern.test(executableContent))
    .map(({ name }) => name);
}

function extractSecretTargetContent(content: string, path: string, depth = 0): string[] {
  const executableContent = [scanDelimiterCode(content).content];
  if (depth >= 16) return executableContent;
  for (const expression of extractInterpolatedStringExpressions(content, path)) {
    executableContent.push(...extractSecretTargetContent(expression, path, depth + 1));
  }
  return executableContent;
}

function extractInterpolatedStringExpressions(content: string, path: string): string[] {
  const expressions: string[] = [];
  for (let quoteIndex = 0; quoteIndex < content.length; quoteIndex += 1) {
    const quote = content[quoteIndex] ?? "";
    if (quote !== '"' && quote !== "'") continue;

    let prefixStart = quoteIndex - 1;
    while (prefixStart >= 0 && /[A-Za-z@$]/.test(content[prefixStart] ?? "")) prefixStart -= 1;
    const prefix = content.slice(prefixStart + 1, quoteIndex);
    const pythonInterpolation = /^[rR]?[fF]$|^[fF][rR]?$/.test(prefix);
    const csharpInterpolation = /^\$+@?$|^@\$+$/.test(prefix);

    const literalBounds = findQuotedLiteralBounds(content, quoteIndex, path, prefix);
    if (!literalBounds) break;
    const literal = content.slice(literalBounds.bodyStart, literalBounds.end);
    if (/\.py$/i.test(path) && pythonInterpolation) {
      expressions.push(...findInterpolationBodies(literal, "{"));
    }
    if (/\.cs$/i.test(path) && csharpInterpolation) {
      const rawDollarCount = prefix.startsWith("$") ? prefix.match(/^\$+/)?.[0].length ?? 1 : 1;
      expressions.push(...findInterpolationBodies(literal, "{".repeat(rawDollarCount)));
    }
    if (/\.rb$/i.test(path) && quote === '"') {
      expressions.push(...findInterpolationBodies(literal, "#{"));
    }
    quoteIndex = literalBounds.end + literalBounds.closingLength - 1;
  }
  return expressions;
}

function findQuotedLiteralBounds(
  content: string,
  quoteIndex: number,
  path: string,
  prefix: string
): { bodyStart: number; end: number; closingLength: number } | null {
  const quote = content[quoteIndex] ?? "";
  const pythonTripleQuoted = /\.py$/i.test(path) && content.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
  const csharpRawQuoted = /\.cs$/i.test(path) && /^\$+$/.test(prefix) &&
    content.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
  let delimiterLength = pythonTripleQuoted || csharpRawQuoted ? 3 : 1;
  if (csharpRawQuoted) {
    while (content[quoteIndex + delimiterLength] === quote) delimiterLength += 1;
  }
  const verbatimCsharp = /\.cs$/i.test(path) && (prefix === "$@" || prefix === "@$");
  const pythonInterpolation = /\.py$/i.test(path) && (/^[rR]?[fF]$|^[fF][rR]?$/.test(prefix));
  const csharpInterpolation = /\.cs$/i.test(path) && /^\$+@?$|^@\$+$/.test(prefix);
  const interpolationMarkerLength = csharpRawQuoted ? prefix.match(/^\$+/)?.[0].length ?? 1 : 1;
  for (let index = quoteIndex + delimiterLength; index < content.length; index += 1) {
    const interpolationStart = content.slice(index, index + interpolationMarkerLength) === "{".repeat(interpolationMarkerLength);
    if ((pythonInterpolation || csharpInterpolation) && interpolationStart) {
      const interpolationEnd = findInterpolationEnd(content, index, interpolationMarkerLength);
      if (interpolationEnd !== null) index = interpolationEnd;
    } else if (verbatimCsharp && content[index] === quote && content[index + 1] === quote) {
      index += 1;
    } else if (!verbatimCsharp && content[index] === "\\") {
      index += 1;
    } else if (content.slice(index, index + delimiterLength) === quote.repeat(delimiterLength)) {
      return {
        bodyStart: quoteIndex + delimiterLength,
        end: index,
        closingLength: delimiterLength
      };
    }
  }
  return null;
}

function findInterpolationEnd(content: string, start: number, markerLength: number): number | null {
  let depth = 1;
  let quote = "";
  let quoteLength = 0;
  let blockComment = false;
  let lineComment = false;
  for (let index = start + markerLength; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
    } else if (lineComment) {
      if (character === "\n") lineComment = false;
    } else if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (content.slice(index, index + quoteLength) === quote.repeat(quoteLength)) {
        index += quoteLength - 1;
        quote = "";
        quoteLength = 0;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
      quoteLength = content.slice(index, index + 3) === character.repeat(3) ? 3 : 1;
      index += quoteLength - 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "#") {
      lineComment = true;
    } else if (character === "\\") {
      index += 1;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && content.slice(index, index + markerLength) === "}".repeat(markerLength)) {
        return index + markerLength - 1;
      }
    }
  }
  return null;
}

function findInterpolationBodies(literal: string, marker: string): string[] {
  const bodies: string[] = [];
  for (let index = 0; index < literal.length; index += 1) {
    if (!literal.startsWith(marker, index)) continue;
    if (marker === "{" && (literal[index - 1] === "{" || literal[index + 1] === "{")) continue;
    const bodyStart = index + marker.length;
    const markerLength = marker === "#{" ? 1 : marker.length;
    const bodyEnd = findInterpolationEnd(literal, marker === "#{" ? index + 1 : index, markerLength);
    if (bodyEnd !== null) {
      const closingStart = bodyEnd - markerLength + 1;
      bodies.push(literal.slice(bodyStart, closingStart));
      index = bodyEnd;
    }
  }
  return bodies;
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
  if (
    CLEAN_PREFIXED_PASS_TEST_LINE_PATTERN.test(normalized) &&
    !AUTHORITATIVE_FAILURE_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }
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
  if (
    CLEAN_PREFIXED_PASS_TEST_LINE_PATTERN.test(normalized) &&
    !AUTHORITATIVE_FAILURE_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }
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
