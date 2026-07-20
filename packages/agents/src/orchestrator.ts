import { deriveSeverity, runRefutationGate } from "@verifier/core";
import type {
  Claim,
  Evidence,
  Finding,
  ReproCommandAuthorizer,
  ReproCommandExecutor,
  RunMeta
} from "@verifier/core";
import { isAbsolute, join, resolve } from "node:path";
import { extractIntent, type ExtractIntentOptions, type IntentExtractorInput } from "./client.js";
import {
  reviewCorrectness,
  type CorrectnessReviewInput,
  type CorrectnessReviewTransport
} from "./correctness/client.js";
import type { CorrectnessReview } from "./correctness/schema.js";
import { recordAgentUsage, type AgentUsage } from "./cost.js";
import { writeClaims, writeJsonArtifact } from "./evidence-store.js";
import { conflictsToFindings, resolveExtractedClaims } from "./intent/index.js";
import type { IntentExtraction } from "./intent/schema.js";
import { refuteFinding, type RefuterTransport } from "./refuter/client.js";
import { StructuredOutputSchemaError } from "./structured-output.js";

export interface RunIntentStageOptions extends ExtractIntentOptions {
  runsRoot?: string;
}

export interface IntentStageResult {
  extraction: IntentExtraction;
  claims: Claim[];
  findings: Finding[];
  runMeta: RunMeta;
  claimsPath: string;
}

export async function runIntentStage(
  input: IntentExtractorInput,
  runMeta: RunMeta,
  options: RunIntentStageOptions = {}
): Promise<IntentStageResult> {
  let extraction: IntentExtraction;
  let usage: AgentUsage;
  let schemaMismatchFinding: Finding[] = [];
  try {
    ({ extraction, usage } = await extractIntent(input, options));
  } catch (error) {
    if (!(error instanceof StructuredOutputSchemaError)) throw error;
    extraction = { claims: [], conflicts: [] };
    usage = error.usage;
    schemaMismatchFinding = [
      {
        id: "F-S0-SCHEMA",
        category: "observation",
        reproduced: false,
        severity: "info",
        title: "Intent agent output unavailable",
        scenario: error.message,
        claimIds: [],
        evidenceIds: [],
        refutation: {
          required: false,
          attempted: false,
          outcome: "skipped",
          evidenceIds: []
        },
        origin: "system"
      }
    ];
  }
  const claims = resolveExtractedClaims(
    extraction,
    input.sources.map(({ source }) => source)
  );
  const updatedRunMeta = recordAgentUsage(
    {
      ...runMeta,
      stagesExecuted: runMeta.stagesExecuted.includes(0)
        ? runMeta.stagesExecuted
        : [...runMeta.stagesExecuted, 0]
    },
    usage
  );
  const claimsPath = await writeClaims(runMeta.runId, claims, options.runsRoot);

  return {
    extraction,
    claims,
    findings: [...conflictsToFindings(extraction.conflicts), ...schemaMismatchFinding],
    runMeta: updatedRunMeta,
    claimsPath
  };
}

export interface RunCorrectnessStageOptions {
  runsRoot?: string;
  transport?: CorrectnessReviewTransport;
}

export interface CorrectnessStageResult {
  review: CorrectnessReview;
  claims: Claim[];
  findings: Finding[];
  evidence: Evidence[];
  runMeta: RunMeta;
  reviewPath: string;
}

export async function runCorrectnessStage(
  input: CorrectnessReviewInput,
  runMeta: RunMeta,
  options: RunCorrectnessStageOptions = {}
): Promise<CorrectnessStageResult> {
  // When more lenses are added, start this cache-priming request first and wait for its
  // response stream to begin before dispatching the remaining lenses in parallel.
  const { review, usage } = await reviewCorrectness(input, options);
  const materialized = materializeCorrectnessReview(review, input.claims);
  const reviewPath = await writeJsonArtifact(
    runMeta.runId,
    "correctness-review.json",
    review,
    options.runsRoot
  );
  const evidence: Evidence[] = materialized.supportedClaimIds.length
    ? [
        {
          id: "E-S3-CORRECTNESS",
          kind: "llm-judgment",
          checkKind: "reading",
          summary: "Correctness lens code-reading assessment.",
          path: "correctness-review.json",
          reproducible: false
        }
      ]
    : [];
  const claims = input.claims.map((claim) =>
    materialized.supportedClaimIds.includes(claim.id)
      ? { ...claim, evidenceIds: [...new Set([...claim.evidenceIds, "E-S3-CORRECTNESS"])] }
      : claim
  );

  return {
    review,
    claims,
    findings: materialized.findings,
    evidence,
    runMeta: recordAgentUsage(withStage(runMeta, 3), usage),
    reviewPath
  };
}

export function materializeCorrectnessReview(
  review: CorrectnessReview,
  claims: Claim[]
): { findings: Finding[]; supportedClaimIds: string[] } {
  const knownClaimIds = new Set(claims.map((claim) => claim.id));
  for (const finding of review.findings) {
    assertKnownClaimIds(finding.claimIds, knownClaimIds);
  }
  for (const assessment of review.claimAssessments) {
    assertKnownClaimIds([assessment.claimId], knownClaimIds);
  }
  const assessedClaimIds = new Set<string>();
  for (const assessment of review.claimAssessments) {
    if (assessedClaimIds.has(assessment.claimId)) {
      throw new Error(`Agent returned duplicate claim assessment: ${assessment.claimId}`);
    }
    assessedClaimIds.add(assessment.claimId);
  }
  const missingClaim = claims.find((claim) => !assessedClaimIds.has(claim.id));
  if (missingClaim) {
    throw new Error(`Agent omitted claim assessment: ${missingClaim.id}`);
  }

  return {
    findings: review.findings.map((finding, index) => ({
      id: `F-S3-${index + 1}`,
      category: finding.category,
      reproduced: false,
      severity: deriveSeverity({ category: finding.category, reproduced: false }, false),
      title: finding.title,
      ...(finding.location
        ? {
            location: {
              file: finding.location.file,
              ...(finding.location.line !== undefined ? { line: finding.location.line } : {})
            }
          }
        : {}),
      scenario: finding.scenario,
      claimIds: [...finding.claimIds],
      evidenceIds: [],
      refutation: {
        required: true,
        attempted: false,
        outcome: "skipped",
        evidenceIds: []
      },
      origin: "stage3",
      lens: "correctness"
    })),
    supportedClaimIds: [
      ...new Set(
        review.claimAssessments
          .filter((assessment) => assessment.supported)
          .map((assessment) => assessment.claimId)
      )
    ]
  };
}

export interface RunRefutationStageOptions {
  workspace: string;
  getRelatedCode: (finding: Finding) => string;
  authorizeCommand?: ReproCommandAuthorizer;
  runsRoot?: string;
  transport?: RefuterTransport;
  executor?: ReproCommandExecutor;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RefutationStageResult {
  findings: Finding[];
  evidence: Evidence[];
  runMeta: RunMeta;
}

export async function runRefutationStage(
  findings: Finding[],
  runMeta: RunMeta,
  options: RunRefutationStageOptions
): Promise<RefutationStageResult> {
  const workspace = resolve(options.workspace);
  const runsRoot = options.runsRoot === undefined
    ? join(workspace, ".verifier", "runs")
    : isAbsolute(options.runsRoot)
      ? resolve(options.runsRoot)
      : resolve(workspace, options.runsRoot);
  const runDir = resolve(runsRoot, runMeta.runId);
  const outputFindings: Finding[] = [];
  const evidence: Evidence[] = [];
  let updatedRunMeta = withStage(runMeta, 4);

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (!finding) continue;

    if (!finding.refutation.required) {
      outputFindings.push(finding);
      continue;
    }

    if (finding.reproduced) {
      const skipped = await runRefutationGate(
        finding,
        { outcome: "survived", reasoning: "Already reproduced." },
        {
          workspace,
          runDir,
          evidenceId: `E-S4-${index + 1}`,
          authorizeCommand: () => false,
          ...(options.executor ? { executor: options.executor } : {})
        }
      );
      outputFindings.push(skipped.finding);
      continue;
    }

    const result = await refuteFinding(
      { finding, relatedCode: options.getRelatedCode(finding) },
      options.transport ? { transport: options.transport } : {}
    );
    updatedRunMeta = recordAgentUsage(updatedRunMeta, result.usage);
    const refuterOutput = {
      outcome: result.refutation.outcome,
      reasoning: result.refutation.reasoning,
      ...(result.refutation.reproCommand !== undefined
        ? { reproCommand: result.refutation.reproCommand }
        : {})
    };
    const gated = await runRefutationGate(finding, refuterOutput, {
      workspace,
      runDir,
      evidenceId: `E-S4-${index + 1}`,
      authorizeCommand: options.authorizeCommand ?? (() => false),
      ...(options.executor ? { executor: options.executor } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {})
    });
    outputFindings.push(gated.finding);
    if (gated.evidence) evidence.push(gated.evidence);
  }

  return { findings: outputFindings, evidence, runMeta: updatedRunMeta };
}

function assertKnownClaimIds(claimIds: string[], knownClaimIds: Set<string>): void {
  const unknown = claimIds.find((claimId) => !knownClaimIds.has(claimId));
  if (unknown) throw new Error(`Agent returned unknown claim ID: ${unknown}`);
}

function withStage(runMeta: RunMeta, stage: number): RunMeta {
  return {
    ...runMeta,
    stagesExecuted: runMeta.stagesExecuted.includes(stage)
      ? runMeta.stagesExecuted
      : [...runMeta.stagesExecuted, stage]
  };
}
