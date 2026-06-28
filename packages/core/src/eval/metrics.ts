import type { MinimalVerdict, VerdictDecision } from "../types.js";

export type EvalKind = "seeded" | "golden";

export interface EvalExpected {
  verdict?: VerdictDecision | undefined;
  verdictAnyOf?: VerdictDecision[] | undefined;
  risk?: MinimalVerdict["risk"] | undefined;
  confidenceMin?: number | undefined;
  confidenceMax?: number | undefined;
  mustFixMin?: number | undefined;
  mustFixMax?: number | undefined;
  shouldFixMin?: number | undefined;
  shouldFixMax?: number | undefined;
  maxFalsePositives?: number | undefined;
}

export interface EvalCaseResult {
  id: string;
  kind: EvalKind;
  description: string;
  passed: boolean;
  failures: string[];
  actual: {
    verdict: VerdictDecision;
    risk: MinimalVerdict["risk"];
    confidence: number;
    mustFixCount: number;
    shouldFixCount: number;
  };
  expected: EvalExpected;
}

export interface EvalMetrics {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  verdictAgreement: number;
  falsePositiveRate: number;
  falsePositiveCases: number;
  cleanCases: number;
  byKind: Record<EvalKind, { total: number; passed: number; failed: number }>;
}

export function compareVerdict(expected: EvalExpected, actual: MinimalVerdict): string[] {
  const failures: string[] = [];
  const expectedVerdicts = expected.verdictAnyOf ?? (expected.verdict ? [expected.verdict] : []);

  if (expectedVerdicts.length > 0 && !expectedVerdicts.includes(actual.verdict)) {
    failures.push(`expected verdict ${expectedVerdicts.join(" or ")}, got ${actual.verdict}`);
  }
  if (expected.risk && actual.risk !== expected.risk) {
    failures.push(`expected risk ${expected.risk}, got ${actual.risk}`);
  }
  if (expected.confidenceMin !== undefined && actual.confidence < expected.confidenceMin) {
    failures.push(`expected confidence >= ${expected.confidenceMin}, got ${actual.confidence}`);
  }
  if (expected.confidenceMax !== undefined && actual.confidence > expected.confidenceMax) {
    failures.push(`expected confidence <= ${expected.confidenceMax}, got ${actual.confidence}`);
  }

  compareCount(failures, "must_fix", actual.must_fix.length, expected.mustFixMin, expected.mustFixMax);
  compareCount(
    failures,
    "should_fix",
    actual.should_fix.length,
    expected.shouldFixMin,
    expected.shouldFixMax
  );

  const maxFalsePositives = expected.maxFalsePositives;
  if (maxFalsePositives !== undefined) {
    const falsePositiveCount = countUnexpectedFindings(expected, actual);
    if (falsePositiveCount > maxFalsePositives) {
      failures.push(
        `expected at most ${maxFalsePositives} false-positive finding(s), got ${falsePositiveCount}`
      );
    }
  }

  return failures;
}

export function calculateEvalMetrics(results: EvalCaseResult[]): EvalMetrics {
  const byKind: EvalMetrics["byKind"] = {
    seeded: { total: 0, passed: 0, failed: 0 },
    golden: { total: 0, passed: 0, failed: 0 }
  };
  let verdictMatches = 0;
  let cleanCases = 0;
  let falsePositiveCases = 0;
  let totalSurvivedFindings = 0;
  let excessFalsePositiveFindings = 0;

  for (const result of results) {
    const bucket = byKind[result.kind];
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
    else bucket.failed += 1;

    const verdictMatched =
      result.expected.verdictAnyOf?.includes(result.actual.verdict) ||
      result.expected.verdict === result.actual.verdict;
    const confidenceWithinMax =
      result.expected.confidenceMax === undefined ||
      result.actual.confidence <= result.expected.confidenceMax;
    if (verdictMatched && confidenceWithinMax) {
      verdictMatches += 1;
    }

    let excessFindings = 0;
    const findingCount = result.actual.mustFixCount + result.actual.shouldFixCount;
    if (result.expected.maxFalsePositives !== undefined) {
      totalSurvivedFindings += findingCount;
      const unexpectedFindings = countUnexpectedFindingCounts(
        result.expected,
        result.actual.mustFixCount,
        result.actual.shouldFixCount
      );
      excessFindings = Math.max(0, unexpectedFindings - result.expected.maxFalsePositives);
      excessFalsePositiveFindings += excessFindings;
    }

    if (isCleanExpected(result.expected)) {
      cleanCases += 1;
      if (excessFindings > 0) falsePositiveCases += 1;
    }
  }

  return {
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    verdictAgreement: ratio(verdictMatches, results.length),
    falsePositiveRate: ratio(excessFalsePositiveFindings, totalSurvivedFindings),
    falsePositiveCases,
    cleanCases,
    byKind
  };
}

function compareCount(
  failures: string[],
  label: string,
  actual: number,
  min?: number,
  max?: number
): void {
  if (min !== undefined && actual < min) {
    failures.push(`expected ${label} count >= ${min}, got ${actual}`);
  }
  if (max !== undefined && actual > max) {
    failures.push(`expected ${label} count <= ${max}, got ${actual}`);
  }
}

function isCleanExpected(expected: EvalExpected): boolean {
  const expectedVerdicts = expected.verdictAnyOf ?? (expected.verdict ? [expected.verdict] : []);
  return expectedVerdicts.length === 1 && expectedVerdicts[0] === "open_pr";
}

function countUnexpectedFindings(expected: EvalExpected, actual: MinimalVerdict): number {
  return countUnexpectedFindingCounts(expected, actual.must_fix.length, actual.should_fix.length);
}

function countUnexpectedFindingCounts(
  expected: EvalExpected,
  mustFixCount: number,
  shouldFixCount: number
): number {
  const expectedMustFixAllowance = expected.mustFixMax ?? expected.mustFixMin ?? 0;
  const expectedShouldFixAllowance = expected.shouldFixMax ?? expected.shouldFixMin ?? 0;
  return (
    Math.max(0, mustFixCount - expectedMustFixAllowance) +
    Math.max(0, shouldFixCount - expectedShouldFixAllowance)
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}
