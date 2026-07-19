import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunMeta } from "@verifier/core";
import {
  recordAgentUsage,
  resolveExtractedClaims,
  runIntentStage,
  writeClaims
} from "../src/index.js";

describe("intent stage orchestration", () => {
  it("maps source references, enforces primary priority, and adds C-0 deterministically", () => {
    const secondary = { tier: "secondary", kind: "commit-message", ref: "commit:1" } as const;
    expect(
      resolveExtractedClaims(
        {
          claims: [
            {
              statement: "Refactor the formatter.",
              priority: "nice-to-verify",
              plannedChecks: ["test"],
              sourceRef: secondary.ref
            }
          ],
          conflicts: []
        },
        [secondary]
      ).map((claim) => claim.id)
    ).toEqual(["C-0", "C-1"]);

    const primary = { tier: "primary", kind: "issue", ref: "issue:1" } as const;
    expect(
      resolveExtractedClaims(
        {
          claims: [
            {
              statement: "Keep authorization checks.",
              priority: "nice-to-verify",
              plannedChecks: ["test"],
              sourceRef: primary.ref
            }
          ],
          conflicts: []
        },
        [primary]
      )[0]
    ).toMatchObject({ id: "C-1", priority: "must-verify", source: primary });
  });

  it("rejects source references that were not supplied", () => {
    expect(() =>
      resolveExtractedClaims(
        {
          claims: [
            {
              statement: "Invented source.",
              priority: "must-verify",
              plannedChecks: [],
              sourceRef: "issue:missing"
            }
          ],
          conflicts: []
        },
        []
      )
    ).toThrow("unknown sourceRef");
  });

  it("records response usage and the fixed model settings", () => {
    const updated = recordAgentUsage(makeRunMeta(), {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 60
    });

    expect(updated.agentConfig).toEqual({
      model: "claude-opus-4-8",
      effort: "medium",
      maxTokens: 4096,
      maxSchemaRetries: 2
    });
    expect(updated.cost.inputTokens).toBe(200);
    expect(updated.cost.outputTokens).toBe(20);
    expect(updated.cost.usd).toBeCloseTo(0.00128, 8);
  });

  it("writes claims under the run directory and rejects unsafe run IDs", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "verifier-runs-"));
    const path = await writeClaims("run-1", [], runsRoot);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
    await expect(writeClaims("../escape", [], runsRoot)).rejects.toThrow("Invalid verifier run ID");
  });

  it("converts conflicts to observations while persisting resolved claims", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "verifier-runs-"));
    const source = { tier: "primary", kind: "issue", ref: "issue:82" } as const;
    const result = await runIntentStage(
      { sources: [{ source, content: "Implement A." }], diffSummary: "Implements B." },
      makeRunMeta(),
      {
        runsRoot,
        transport: async () => ({
          parsed_output: {
            claims: [
              {
                statement: "Implement A.",
                priority: "must-verify",
                plannedChecks: ["reading"],
                sourceRef: source.ref
              }
            ],
            conflicts: ["The diff implements B instead of A."]
          },
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null
          }
        })
      }
    );

    expect(result.findings).toMatchObject([
      { category: "observation", severity: "info", origin: "stage0" }
    ]);
    expect(result.runMeta.stagesExecuted).toContain(0);
    expect(JSON.parse(await readFile(result.claimsPath, "utf8"))).toEqual(result.claims);
  });
});

function makeRunMeta(): RunMeta {
  return {
    runId: "run-1",
    startedAt: "2026-07-19T00:00:00.000Z",
    baseRef: "main",
    headRef: "feature",
    trustLevel: "trusted",
    stagesExecuted: [],
    stagesSkipped: [],
    targets: ["cli"],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0 },
    durationMs: 0
  };
}
