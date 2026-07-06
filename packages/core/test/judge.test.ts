import { describe, expect, it } from "vitest";
import {
  calculateConfidence,
  decideVerdict,
  deriveClaimStatus,
  deriveSeverity,
  ensureSyntheticPrimaryClaim,
  hasEnvFailure,
  judge,
  SYNTHETIC_PRIMARY_CLAIM_ID,
  SYNTHETIC_PRIMARY_CLAIM_STATEMENT
} from "../src/judge/index.js";
import type { CheckKind, Claim, Evidence, Finding, RunMeta, Severity } from "../src/judge/index.js";

describe("Stage 6 judge", () => {
  it.each([
    [{ category: "observation", reproduced: true }, true, "info"],
    [{ category: "logic", reproduced: true }, true, "blocker"],
    [{ category: "security", reproduced: true }, false, "blocker"],
    [{ category: "data-loss", reproduced: false }, false, "major"],
    [{ category: "logic", reproduced: true }, false, "major"],
    [{ category: "perf", reproduced: false }, false, "minor"],
    [{ category: "style", reproduced: true }, false, "minor"]
  ] as const)("derives severity %#", (finding, failedMustClaim, expected) => {
    expect(deriveSeverity(finding, failedMustClaim)).toBe(expected);
  });

  it("derives claim status from survived findings before positive evidence", () => {
    const claim = makeClaim({ id: "C-1", evidenceIds: ["E-1"] });
    expect(deriveClaimStatus(claim, [makeFinding({ claimIds: ["C-1"], reproduced: true })], [
      makeEvidence({ id: "E-1", checkKind: "test" })
    ])).toBe("failed");
  });

  it("derives verified and unverified claim statuses", () => {
    const claim = makeClaim({ id: "C-1", evidenceIds: ["E-1"] });
    expect(deriveClaimStatus(claim, [], [makeEvidence({ id: "E-1", checkKind: "test" })])).toBe(
      "verified"
    );
    expect(deriveClaimStatus(claim, [], [])).toBe("unverified");
  });

  it("decides not mergeable for blockers and failed must-verify claims", () => {
    expect(decideVerdict([makeClaim({ status: "verified" })], [
      makeFinding({ severity: "blocker" })
    ], makeRunMeta())).toBe("not_mergeable");

    expect(decideVerdict([makeClaim({ status: "failed" })], [], makeRunMeta())).toBe(
      "not_mergeable"
    );
  });

  it("decides inconclusive when all planned checks for a must claim are env failures", () => {
    const runMeta = makeRunMeta({
      stagesSkipped: [
        { stage: 1, reasonCode: "env-failure", reason: "typecheck command missing" },
        { stage: 2, reasonCode: "env-failure", reason: "test command missing" }
      ]
    });

    expect(
      hasEnvFailure([makeClaim({ plannedChecks: ["static", "test"], status: "unverified" })], runMeta.stagesSkipped)
    ).toBe(true);
    expect(
      decideVerdict(
        [makeClaim({ plannedChecks: ["static", "test"], status: "unverified" })],
        [],
        runMeta
      )
    ).toBe("inconclusive");
  });

  it("does not treat empty planned checks as env failures", () => {
    const runMeta = makeRunMeta({
      stagesSkipped: [{ stage: 1, reasonCode: "env-failure", reason: "typecheck command missing" }]
    });

    expect(hasEnvFailure([makeClaim({ plannedChecks: [], status: "unverified" })], runMeta.stagesSkipped)).toBe(
      false
    );
  });

  it("decides conditional for major findings or unverified must-verify claims", () => {
    expect(decideVerdict([makeClaim({ status: "verified" })], [
      makeFinding({ severity: "major" })
    ], makeRunMeta())).toBe("conditional");

    expect(decideVerdict([makeClaim({ status: "unverified" })], [], makeRunMeta())).toBe(
      "conditional"
    );
  });

  it("decides mergeable when there are no blockers, major findings, env failures, or unverified must claims", () => {
    expect(decideVerdict([makeClaim({ status: "verified" })], [
      makeFinding({ severity: "minor" }),
      makeFinding({ id: "F-2", severity: "info" })
    ], makeRunMeta())).toBe("mergeable");
  });

  it("calculates the DESIGN.md section 4 confidence example as 70", () => {
    const claims = [
      makeClaim({ id: "C-1", evidenceIds: ["E-1"], status: "verified" }),
      makeClaim({ id: "C-2", evidenceIds: ["E-2"], status: "verified" }),
      makeClaim({ id: "C-3", evidenceIds: ["E-3"], status: "verified" }),
      makeClaim({
        id: "C-4",
        priority: "nice-to-verify",
        sourceTier: "secondary",
        evidenceIds: [],
        status: "unverified"
      })
    ];
    const evidence = [
      makeEvidence({ id: "E-1", checkKind: "test" }),
      makeEvidence({ id: "E-2", checkKind: "test" }),
      makeEvidence({ id: "E-3", checkKind: "runtime" })
    ];
    const findings = [
      makeFinding({ id: "F-1", severity: "major" }),
      makeFinding({ id: "F-2", severity: "minor" })
    ];

    expect(calculateConfidence(claims, findings, evidence)).toBe(70);
  });

  it("uses survived finding evidence when calculating failed claim confidence", () => {
    const claim = makeClaim({ id: "C-1", evidenceIds: [], status: "failed" });
    const finding = makeFinding({
      category: "regression",
      reproduced: true,
      severity: "blocker",
      claimIds: ["C-1"],
      evidenceIds: ["E-1"]
    });
    const evidence = [makeEvidence({ id: "E-1", checkKind: "runtime" })];

    expect(calculateConfidence([claim], [finding], evidence)).toBe(85);
  });

  it("clamps confidence and returns 0 for empty claims", () => {
    expect(calculateConfidence([], [], [])).toBe(0);
    expect(
      calculateConfidence([makeClaim({ evidenceIds: ["E-1"], status: "verified" })], [
        makeFinding({ severity: "blocker" }),
        makeFinding({ id: "F-2", severity: "blocker" })
      ], [makeEvidence({ id: "E-1", checkKind: "reading" })])
    ).toBe(20);
  });

  it("generates synthetic C-0 when no claim comes from a primary source", () => {
    const secondaryClaim = makeClaim({ id: "C-1", sourceTier: "secondary" });
    const claims = ensureSyntheticPrimaryClaim([secondaryClaim]);

    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      id: SYNTHETIC_PRIMARY_CLAIM_ID,
      statement: SYNTHETIC_PRIMARY_CLAIM_STATEMENT,
      priority: "must-verify",
      plannedChecks: [],
      status: "unverified",
      evidenceIds: []
    });
    expect(ensureSyntheticPrimaryClaim(claims)).toBe(claims);
  });

  it("does not generate synthetic C-0 when a primary claim exists", () => {
    const claims = [makeClaim({ id: "C-1", sourceTier: "primary" })];
    expect(ensureSyntheticPrimaryClaim(claims)).toBe(claims);
  });

  it("integrates synthetic claims, status derivation, severity derivation, verdict, and confidence without mutating inputs", () => {
    const inputClaim = makeClaim({
      id: "C-1",
      priority: "nice-to-verify",
      sourceTier: "secondary",
      evidenceIds: ["E-1"],
      status: "unverified"
    });
    const inputFinding = makeFinding({ category: "logic", reproduced: true, severity: "minor" });

    const verdict = judge([inputClaim], [inputFinding], [
      makeEvidence({ id: "E-1", checkKind: "reading" })
    ], makeRunMeta());

    expect(verdict.kind).toBe("conditional");
    expect(verdict.claims.map((claim) => claim.id)).toEqual(["C-0", "C-1"]);
    expect(verdict.claims[0]?.status).toBe("unverified");
    expect(verdict.claims[1]?.status).toBe("verified");
    expect(verdict.findings[0]?.severity).toBe("major");
    expect(inputClaim.status).toBe("unverified");
    expect(inputFinding.severity).toBe("minor");
  });

  it("honors refuter-confirmed reproduction before deriving status and severity", () => {
    const claim = makeClaim({ id: "C-1", evidenceIds: ["E-1"], status: "verified" });
    const finding = makeFinding({
      category: "logic",
      reproduced: false,
      severity: "minor",
      claimIds: ["C-1"],
      refutation: {
        required: true,
        attempted: true,
        outcome: "survived",
        reproConfirmed: true,
        evidenceIds: ["E-2"]
      }
    });

    const verdict = judge([claim], [finding], [
      makeEvidence({ id: "E-1", checkKind: "test" }),
      makeEvidence({ id: "E-2", checkKind: "runtime" })
    ], makeRunMeta());

    expect(verdict.kind).toBe("not_mergeable");
    expect(verdict.claims[0]?.status).toBe("failed");
    expect(verdict.findings[0]).toMatchObject({
      reproduced: true,
      severity: "blocker"
    });
    expect(finding.reproduced).toBe(false);
    expect(finding.severity).toBe("minor");
  });
});

function makeClaim(
  overrides: Partial<Claim> & { sourceTier?: Claim["source"]["tier"] } = {}
): Claim {
  const { sourceTier, ...claimOverrides } = overrides;
  return {
    id: "C-1",
    statement: "The change preserves expected behavior.",
    priority: "must-verify",
    source: {
      tier: sourceTier ?? "primary",
      kind: "issue",
      ref: "https://example.test/issues/1"
    },
    plannedChecks: ["test"],
    status: "verified",
    evidenceIds: [],
    ...claimOverrides
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    category: "logic",
    reproduced: false,
    severity: "minor",
    title: "Incorrect edge-case handling",
    scenario: "An edge case returns the wrong result.",
    claimIds: [],
    evidenceIds: [],
    refutation: {
      required: true,
      attempted: true,
      outcome: "survived",
      evidenceIds: []
    },
    origin: "stage3",
    ...overrides
  };
}

function makeEvidence(overrides: Partial<Evidence> & { checkKind: CheckKind; id: string }): Evidence {
  return {
    kind: "test-result",
    summary: "Relevant check passed.",
    path: `.verifier/runs/test/evidence/${overrides.id}.txt`,
    reproducible: true,
    ...overrides
  };
}

function makeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: "run-1",
    startedAt: "2026-07-06T00:00:00.000Z",
    baseRef: "main",
    headRef: "feature",
    trustLevel: "trusted",
    stagesExecuted: [0, 1, 2, 3, 6],
    stagesSkipped: [],
    targets: ["cli"],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0 },
    durationMs: 10,
    ...overrides
  };
}
