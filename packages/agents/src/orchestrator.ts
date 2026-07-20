import type { Claim, Finding, RunMeta } from "@verifier/core";
import {
  extractIntent,
  IntentSchemaMismatchError,
  type ExtractIntentOptions,
  type IntentExtractorInput
} from "./client.js";
import { recordAgentUsage, type AgentUsage } from "./cost.js";
import { writeClaims } from "./evidence-store.js";
import { conflictsToFindings, resolveExtractedClaims } from "./intent/index.js";
import type { IntentExtraction } from "./intent/schema.js";

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
    if (!(error instanceof IntentSchemaMismatchError)) throw error;
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
