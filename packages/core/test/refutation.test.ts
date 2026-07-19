import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeReproCommand,
  runRefutationGate,
  type ReproCommandExecutor
} from "../src/refutation/index.js";
import type { Finding } from "../src/judge/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("refutation gate", () => {
  it("keeps reproduction commands as data until the orchestrator executor is invoked", async () => {
    const workspace = await makeWorkspace();
    let receivedCommand: string | undefined;
    const executor: ReproCommandExecutor = async (command) => {
      receivedCommand = command;
      return commandResult({ command, code: 0, stdout: "reproduced\n" });
    };

    const result = await runRefutationGate(
      makeFinding(),
      { outcome: "survived", reasoning: "The edge case is reachable.", reproCommand: "pnpm test edge" },
      {
        workspace,
        runDir: join(workspace, ".verifier/runs/run-1"),
        evidenceId: "E-R1",
        executor
      }
    );

    expect(receivedCommand).toBe("pnpm test edge");
    expect(result.finding).toMatchObject({
      reproduced: false,
      refutation: { outcome: "survived", reproConfirmed: true, evidenceIds: ["E-R1"] },
      evidenceIds: ["E-R1"]
    });
    expect(result.evidence).toMatchObject({ id: "E-R1", checkKind: "runtime" });
  });

  it("overrides a contradictory refuted outcome when the reproduction succeeds", async () => {
    const workspace = await makeWorkspace();
    const result = await runRefutationGate(
      makeFinding(),
      { outcome: "refuted", reasoning: "Model believed the path was unreachable.", reproCommand: "test" },
      gateOptions(workspace, async (command) => commandResult({ command, code: 0 }))
    );

    expect(result.finding.refutation).toMatchObject({ outcome: "survived", reproConfirmed: true });
  });

  it.each([
    ["failed", commandResult({ command: "test", code: 1 }), "refuted"],
    ["timed out", commandResult({ command: "test", code: null, timedOut: true }), "survived"]
  ] as const)("does not confirm reproduction when execution %s", async (_label, execution, outcome) => {
    const workspace = await makeWorkspace();
    const result = await runRefutationGate(
      makeFinding(),
      { outcome, reasoning: "Model assessment.", reproCommand: "test" },
      gateOptions(workspace, async () => execution)
    );

    expect(result.finding.refutation.outcome).toBe(outcome);
    expect(result.finding.refutation.reproConfirmed).toBeUndefined();
  });

  it("does not execute a command for an already reproduced finding", async () => {
    const workspace = await makeWorkspace();
    const executor: ReproCommandExecutor = async () => {
      throw new Error("executor must not run");
    };
    const result = await runRefutationGate(
      makeFinding({ reproduced: true }),
      { outcome: "survived", reasoning: "unused", reproCommand: "test" },
      gateOptions(workspace, executor)
    );

    expect(result.finding.refutation).toMatchObject({ required: false, attempted: false, outcome: "skipped" });
    expect(result.evidence).toBeUndefined();
  });

  it("records a refuter outcome without running a missing reproduction command", async () => {
    const workspace = await makeWorkspace();
    const result = await runRefutationGate(
      makeFinding(),
      { outcome: "refuted", reasoning: "The scenario contradicts the implementation." },
      gateOptions(workspace, async () => {
        throw new Error("executor must not run");
      })
    );

    expect(result.finding.refutation).toMatchObject({
      required: true,
      attempted: true,
      outcome: "refuted",
      notes: "The scenario contradicts the implementation."
    });
  });

  it("writes redacted command evidence inside the workspace", async () => {
    const workspace = await makeWorkspace();
    const runDir = join(workspace, ".verifier/runs/run-1");
    await runRefutationGate(
      makeFinding(),
      { outcome: "survived", reasoning: "reachable", reproCommand: "test" },
      {
        workspace,
        runDir,
        evidenceId: "E-R1",
        executor: async (command) =>
          commandResult({ command, code: 0, stdout: "token=super-secret-value\n" })
      }
    );

    const log = await readFile(join(runDir, "evidence/E-R1.txt"), "utf8");
    expect(log).toContain("token=[REDACTED]");
    expect(log).not.toContain("super-secret-value");
  });

  it("rejects evidence paths outside the workspace", async () => {
    const workspace = await makeWorkspace();
    await expect(
      runRefutationGate(
        makeFinding(),
        { outcome: "survived", reasoning: "reachable", reproCommand: "test" },
        {
          workspace,
          runDir: join(workspace, "..", "outside"),
          evidenceId: "E-R1",
          executor: async (command) => commandResult({ command, code: 0 })
        }
      )
    ).rejects.toThrow("runDir must be a child");
  });

  it("rejects evidence IDs that could escape the evidence directory", async () => {
    const workspace = await makeWorkspace();
    await expect(
      runRefutationGate(
        makeFinding(),
        { outcome: "survived", reasoning: "reachable", reproCommand: "test" },
        {
          workspace,
          runDir: join(workspace, ".verifier/runs/run-1"),
          evidenceId: "../../outside",
          executor: async (command) => commandResult({ command, code: 0 })
        }
      )
    ).rejects.toThrow("Invalid refutation evidence ID");
  });

  it("bounds output collected by the default executor", async () => {
    const workspace = await makeWorkspace();
    const result = await executeReproCommand(
      `${process.execPath} -e "process.stdout.write('1234567890')"`,
      { workspace, timeoutMs: 2_000, maxOutputBytes: 4 }
    );

    expect(result).toMatchObject({ code: 0, stdout: "1234", outputTruncated: true });
  });
});

async function makeWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "verifier-refutation-"));
  temporaryDirectories.push(path);
  return path;
}

function gateOptions(workspace: string, executor: ReproCommandExecutor) {
  return {
    workspace,
    runDir: join(workspace, ".verifier/runs/run-1"),
    evidenceId: "E-R1",
    executor
  };
}

function commandResult(overrides: Partial<Awaited<ReturnType<ReproCommandExecutor>>> & { command: string }) {
  return {
    command: overrides.command,
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
    ...overrides
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    category: "logic",
    reproduced: false,
    severity: "minor",
    title: "Incorrect edge-case handling",
    scenario: "An empty input returns the wrong result.",
    claimIds: ["C-1"],
    evidenceIds: [],
    refutation: {
      required: true,
      attempted: false,
      outcome: "skipped",
      evidenceIds: []
    },
    origin: "stage3",
    lens: "correctness",
    ...overrides
  };
}
