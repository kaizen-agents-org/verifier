import {
  CHECK_KIND_STRENGTHS,
  CLAIM_WEIGHTS,
  FINDING_SEVERITY_PENALTIES
} from "./constants.js";
import type {
  CheckKind,
  Claim,
  ClaimStatus,
  Evidence,
  Finding,
  FindingCategory,
  RunMeta,
  Severity,
  Verdict,
  VerdictKind
} from "./types.js";

export * from "./constants.js";
export * from "./types.js";

const CRITICAL_FINDING_CATEGORIES: FindingCategory[] = [
  "security",
  "data-loss",
  "crash",
  "regression"
];

const CHECK_KIND_STAGE: Record<CheckKind, number> = {
  static: 1,
  test: 2,
  reading: 3,
  runtime: 5
};

export const SYNTHETIC_PRIMARY_CLAIM_ID = "C-0";
export const SYNTHETIC_PRIMARY_CLAIM_STATEMENT = "変更の意図が一次ソースから特定できる";

export function deriveSeverity(
  finding: Pick<Finding, "category" | "reproduced">,
  failedMustClaim: boolean
): Severity {
  if (finding.category === "observation") return "info";
  if (failedMustClaim) return "blocker";
  if (CRITICAL_FINDING_CATEGORIES.includes(finding.category)) {
    return finding.reproduced ? "blocker" : "major";
  }
  if (finding.category === "logic" || finding.category === "perf") {
    return finding.reproduced ? "major" : "minor";
  }
  return "minor";
}

export function deriveClaimStatus(
  claim: Claim,
  survivedFindings: Finding[],
  evidence: Evidence[]
): ClaimStatus {
  if (survivedFindings.some((finding) => finding.claimIds.includes(claim.id) && finding.reproduced)) {
    return "failed";
  }
  const hasClaimEvidence = evidence.some((item) => claim.evidenceIds.includes(item.id));
  if (hasClaimEvidence) return "verified";
  return "unverified";
}

export function ensureSyntheticPrimaryClaim(claims: Claim[]): Claim[] {
  if (claims.some((claim) => claim.source.tier === "primary")) return claims;
  return [createSyntheticPrimaryClaim(), ...claims];
}

export function createSyntheticPrimaryClaim(): Claim {
  return {
    id: SYNTHETIC_PRIMARY_CLAIM_ID,
    statement: SYNTHETIC_PRIMARY_CLAIM_STATEMENT,
    priority: "must-verify",
    source: {
      tier: "primary",
      kind: "user-prompt",
      ref: "synthetic:missing-primary-source"
    },
    plannedChecks: [],
    status: "unverified",
    evidenceIds: []
  };
}

export function hasEnvFailure(claims: Claim[], stagesSkipped: RunMeta["stagesSkipped"]): boolean {
  const envFailureStages = new Set(
    stagesSkipped
      .filter((stage) => stage.reasonCode === "env-failure")
      .map((stage) => stage.stage)
  );

  return claims.some((claim) => {
    if (claim.priority !== "must-verify" || claim.plannedChecks.length === 0) return false;
    return claim.plannedChecks.every((checkKind) => envFailureStages.has(CHECK_KIND_STAGE[checkKind]));
  });
}

export function decideVerdict(claims: Claim[], findings: Finding[], runMeta: RunMeta): VerdictKind {
  const envFailure = hasEnvFailure(claims, runMeta.stagesSkipped);
  const survived = findings.filter((finding) => finding.refutation.outcome !== "refuted");
  if (survived.some((finding) => finding.severity === "blocker")) return "not_mergeable";
  if (claims.some((claim) => claim.priority === "must-verify" && claim.status === "failed")) {
    return "not_mergeable";
  }
  if (envFailure) return "inconclusive";
  const mustUnverified = claims.some(
    (claim) => claim.priority === "must-verify" && claim.status === "unverified"
  );
  if (survived.some((finding) => finding.severity === "major") || mustUnverified) {
    return "conditional";
  }
  return "mergeable";
}

export function calculateConfidence(
  claims: Claim[],
  survivedFindings: Finding[],
  evidence: Evidence[]
): number {
  if (claims.length === 0) return 0;

  const weightedEvidence = claims.reduce((total, claim) => {
    const weight = CLAIM_WEIGHTS[claim.priority];
    const verificationValue = claim.status === "unverified" ? 0 : 1;
    return total + weight * maxEvidenceStrength(claim, survivedFindings, evidence) * verificationValue;
  }, 0);

  const totalWeight = claims.reduce((total, claim) => total + CLAIM_WEIGHTS[claim.priority], 0);
  const penalty = survivedFindings.reduce(
    (total, finding) => total + FINDING_SEVERITY_PENALTIES[finding.severity],
    0
  );

  return clamp(Math.round((100 * weightedEvidence) / totalWeight) - penalty, 0, 100);
}

export function judge(
  claims: Claim[],
  findings: Finding[],
  evidence: Evidence[],
  runMeta: RunMeta
): Verdict {
  const claimsWithSynthetic = ensureSyntheticPrimaryClaim(claims);
  const reproducedFindings = applyRefutationReproduction(findings);
  const findingsWithSeverity = deriveFindingSeverities(reproducedFindings, claimsWithSynthetic);
  const survivedFindings = findingsWithSeverity.filter(
    (finding) => finding.refutation.outcome !== "refuted"
  );
  const discardedFindings = findingsWithSeverity.filter(
    (finding) => finding.refutation.outcome === "refuted"
  );
  const claimsWithStatus = claimsWithSynthetic.map((claim) => ({
    ...claim,
    status: deriveClaimStatus(claim, survivedFindings, evidence)
  }));

  const kind = decideVerdict(claimsWithStatus, survivedFindings, runMeta);

  return {
    schemaVersion: 1,
    kind,
    confidence: calculateConfidence(claimsWithStatus, survivedFindings, evidence),
    conditions: deriveConditions(claimsWithStatus, survivedFindings, kind),
    claims: claimsWithStatus,
    findings: survivedFindings,
    discardedFindings,
    evidence,
    run: runMeta
  };
}

function deriveFindingSeverities(findings: Finding[], claims: Claim[]): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    severity: deriveSeverity(finding, failsMustClaim(finding, claims))
  }));
}

function applyRefutationReproduction(findings: Finding[]): Finding[] {
  return findings.map((finding) => {
    if (finding.reproduced || finding.refutation.reproConfirmed !== true) return finding;
    return { ...finding, reproduced: true };
  });
}

function failsMustClaim(finding: Finding, claims: Claim[]): boolean {
  if (!finding.reproduced) return false;
  return claims.some(
    (claim) => claim.priority === "must-verify" && finding.claimIds.includes(claim.id)
  );
}

function maxEvidenceStrength(claim: Claim, survivedFindings: Finding[], evidence: Evidence[]): number {
  const claimEvidenceIds = new Set(claim.evidenceIds);
  for (const finding of survivedFindings) {
    if (finding.claimIds.includes(claim.id)) {
      for (const evidenceId of finding.evidenceIds) {
        claimEvidenceIds.add(evidenceId);
      }
    }
  }

  return evidence.reduce((maxStrength, item) => {
    if (!claimEvidenceIds.has(item.id)) return maxStrength;
    return Math.max(maxStrength, CHECK_KIND_STRENGTHS[item.checkKind]);
  }, 0);
}

function deriveConditions(claims: Claim[], findings: Finding[], kind: VerdictKind): string[] {
  if (kind !== "conditional") return [];
  const claimConditions = claims
    .filter((claim) => claim.priority === "must-verify" && claim.status === "unverified")
    .map((claim) => `Verify must-verify claim ${claim.id}: ${claim.statement}`);
  const findingConditions = findings
    .filter((finding) => finding.severity === "major")
    .map((finding) => `Resolve major finding ${finding.id}: ${finding.title}`);
  return [...claimConditions, ...findingConditions];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
