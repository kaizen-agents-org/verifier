import type { Claim, Finding, IntentSource } from "@verifier/core";
import { ensureSyntheticPrimaryClaim } from "@verifier/core";
import type { IntentExtraction } from "./schema.js";

export function resolveExtractedClaims(
  extraction: IntentExtraction,
  sources: IntentSource[]
): Claim[] {
  const sourcesByRef = new Map(sources.map((source) => [source.ref, source]));
  const claims = extraction.claims.map((claim, index): Claim => {
    const source = sourcesByRef.get(claim.sourceRef);
    if (!source) {
      throw new Error(`Intent extractor returned unknown sourceRef: ${claim.sourceRef}`);
    }
    return {
      id: `C-${index + 1}`,
      statement: claim.statement,
      priority: source.tier === "primary" ? "must-verify" : claim.priority,
      source,
      plannedChecks: claim.plannedChecks,
      status: "unverified",
      evidenceIds: []
    };
  });

  return ensureSyntheticPrimaryClaim(claims);
}

export function conflictsToFindings(conflicts: string[]): Finding[] {
  return conflicts.map((conflict, index) => ({
    id: `F-S0-${index + 1}`,
    category: "observation",
    reproduced: false,
    severity: "info",
    title: "Intent conflict",
    scenario: conflict,
    claimIds: [],
    evidenceIds: [],
    refutation: {
      required: false,
      attempted: false,
      outcome: "skipped",
      evidenceIds: []
    },
    origin: "stage0"
  }));
}
