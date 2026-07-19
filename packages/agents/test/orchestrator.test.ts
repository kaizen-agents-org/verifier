import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Claim, Finding, RunMeta } from "@verifier/core";
import {
  materializeCorrectnessReview,
  recordAgentUsage,
  resolveExtractedClaims,
  runCorrectnessStage,
  runIntentStage,
  runRefutationStage,
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

describe("correctness and refutation orchestration", () => {
  it("materializes severity-free lens findings and rejects invented claim IDs", () => {
    const claim = makeClaim();
    expect(
      materializeCorrectnessReview(
        {
          findings: [
            {
              category: "logic",
              title: "Wrong empty result",
              scenario: "An empty input returns one item.",
              claimIds: [claim.id]
            }
          ],
          claimAssessments: [{ claimId: claim.id, supported: false, note: "Wrong branch." }]
        },
        [claim]
      ).findings[0]
    ).toMatchObject({ severity: "minor", reproduced: false, lens: "correctness" });

    expect(() =>
      materializeCorrectnessReview(
        {
          findings: [],
          claimAssessments: [{ claimId: "C-missing", supported: true, note: "Invented." }]
        },
        [claim]
      )
    ).toThrow("unknown claim ID");
  });

  it("persists the lens output and links supported claims to reading evidence", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "verifier-runs-"));
    const claim = makeClaim();
    const result = await runCorrectnessStage(
      { diff: "diff", context: "code", claims: [claim] },
      makeRunMeta(),
      {
        runsRoot,
        transport: async () => ({
          parsed_output: {
            findings: [],
            claimAssessments: [{ claimId: claim.id, supported: true, note: "Matches code." }]
          },
          stop_reason: "end_turn",
          usage: usage()
        })
      }
    );

    expect(result.claims[0]?.evidenceIds).toContain("E-S3-CORRECTNESS");
    expect(result.evidence).toMatchObject([{ checkKind: "reading" }]);
    expect(result.runMeta.stagesExecuted).toContain(3);
    expect(JSON.parse(await readFile(result.reviewPath, "utf8"))).toEqual(result.review);
  });

  it("lets only the orchestrator execute a refuter command and records runtime evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "verifier-workspace-"));
    const finding = makeFinding();
    const result = await runRefutationStage([finding], makeRunMeta(), {
      workspace,
      getRelatedCode: () => "code",
      transport: async () => ({
        parsed_output: {
          outcome: "survived",
          reasoning: "The bad branch is reachable.",
          reproCommand: "pnpm test empty"
        },
        stop_reason: "end_turn",
        usage: usage()
      }),
      executor: async (command) => ({
        command,
        code: 0,
        signal: null,
        stdout: "reproduced",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        outputTruncated: false
      })
    });

    expect(result.findings[0]?.refutation).toMatchObject({
      outcome: "survived",
      reproConfirmed: true
    });
    expect(result.evidence).toMatchObject([{ checkKind: "runtime" }]);
    expect(result.runMeta.stagesExecuted).toContain(4);
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

function makeClaim(): Claim {
  return {
    id: "C-1",
    statement: "Empty input remains empty.",
    priority: "must-verify",
    source: { tier: "primary", kind: "issue", ref: "issue:83" },
    plannedChecks: ["reading", "test"],
    status: "unverified",
    evidenceIds: []
  };
}

function makeFinding(): Finding {
  return {
    id: "F-S3-1",
    category: "logic",
    reproduced: false,
    severity: "minor",
    title: "Wrong empty result",
    scenario: "An empty input returns one item.",
    claimIds: ["C-1"],
    evidenceIds: [],
    refutation: { required: true, attempted: false, outcome: "skipped", evidenceIds: [] },
    origin: "stage3",
    lens: "correctness"
  };
}

function usage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}
