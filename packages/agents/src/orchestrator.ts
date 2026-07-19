import type { Claim, Finding, RunMeta } from "@verifier/core";
import { extractIntent, type ExtractIntentOptions, type IntentExtractorInput } from "./client.js";
import { recordAgentUsage } from "./cost.js";
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
  const { extraction, usage } = await extractIntent(input, options);
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
    findings: conflictsToFindings(extraction.conflicts),
    runMeta: updatedRunMeta,
    claimsPath
  };
}
