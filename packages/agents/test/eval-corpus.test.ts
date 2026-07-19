import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judge, type RunMeta } from "@verifier/core";
import { runIntentStage, type IntentExtractorTransport } from "../src/index.js";

interface CorpusCase {
  input: { task: string; diff: string };
}

describe("EVAL.md Stage 0 acceptance cases", () => {
  it("sb-009 produces synthetic C-0, conditional, and confidence <= 50", async () => {
    const testCase = await loadCorpusCase("sb-009-unexplained-diff-needs-context.json");
    const result = await runIntentStage(
      { sources: [], diffSummary: testCase.input.diff },
      makeRunMeta("sb-009"),
      { runsRoot: await temporaryRunsRoot(), transport: transportFor({ claims: [], conflicts: [] }) }
    );
    const verdict = judge(result.claims, result.findings, [], result.runMeta);

    expect(testCase.input.task).toBe("");
    expect(verdict.kind).toBe("conditional");
    expect(verdict.confidence).toBeLessThanOrEqual(50);
    expect(verdict.claims[0]).toMatchObject({
      id: "C-0",
      priority: "must-verify",
      status: "unverified"
    });
  });

  it("sb-010 preserves the primary must claim and returns an allowed verdict", async () => {
    const testCase = await loadCorpusCase("sb-010-removed-auth-check-blocks.json");
    const source = {
      tier: "primary" as const,
      kind: "issue" as const,
      ref: "corpus:sb-010"
    };
    const result = await runIntentStage(
      {
        sources: [{ source, content: testCase.input.task }],
        diffSummary: testCase.input.diff
      },
      makeRunMeta("sb-010"),
      {
        runsRoot: await temporaryRunsRoot(),
        transport: transportFor({
          claims: [
            {
              statement: testCase.input.task,
              priority: "must-verify",
              plannedChecks: ["reading"],
              sourceRef: source.ref
            }
          ],
          conflicts: ["The diff removes authorization rather than only refactoring the handler."]
        })
      }
    );
    const verdict = judge(result.claims, result.findings, [], result.runMeta);

    expect(verdict.claims).toMatchObject([
      { id: "C-1", source: { tier: "primary" }, priority: "must-verify", status: "unverified" }
    ]);
    expect(["conditional", "not_mergeable"]).toContain(verdict.kind);
    expect(result.findings).toHaveLength(1);
  });
});

function transportFor(parsed_output: NonNullable<Awaited<ReturnType<IntentExtractorTransport>>["parsed_output"]>): IntentExtractorTransport {
  return async () => ({
    parsed_output,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null
    }
  });
}

async function loadCorpusCase(file: string): Promise<CorpusCase> {
  const path = fileURLToPath(
    new URL(`../../core/eval/corpus/seeded/${file}`, import.meta.url)
  );
  return JSON.parse(await readFile(path, "utf8")) as CorpusCase;
}

async function temporaryRunsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "verifier-eval-runs-"));
}

function makeRunMeta(runId: string): RunMeta {
  return {
    runId,
    startedAt: "2026-07-19T00:00:00.000Z",
    baseRef: "main",
    headRef: "feature",
    trustLevel: "trusted",
    stagesExecuted: [0, 6],
    stagesSkipped: [],
    targets: ["cli"],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0 },
    durationMs: 0
  };
}
