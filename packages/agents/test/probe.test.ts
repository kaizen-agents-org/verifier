import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LaunchError, judge, type Claim, type LaunchContext, type PortAllocator, type RunMeta, type Scenario } from "@verifier/core";
import { ApiProbeDriver } from "@verifier/probe-driver-api";
import { CliProbeDriver } from "@verifier/probe-driver-cli";
import {
  generateScenarios,
  runProbeAndRefuteStage,
  runProbeStage,
  runScenarioGenerationStage
} from "../src/index.js";

const cliFixture = resolve(import.meta.dirname, "../../../fixtures/probe/cli-tool/cli.mjs");
const apiFixture = resolve(import.meta.dirname, "../../../fixtures/probe/api-server/server.mjs");

describe("scenario generator authority", () => {
  it("accepts registered command IDs, records usage, and persists scenarios", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "verifier-scenario-"));
    const result = await runScenarioGenerationStage(
      {
        diff: "diff",
        targetType: "cli",
        claims: [claim()],
        allowedCommandIds: ["convert"]
      },
      runMeta(),
      {
        runsRoot,
        transport: async () => ({
          parsed_output: {
            scenarios: [cliScenario()]
          },
          stop_reason: "end_turn",
          usage: usage()
        })
      }
    );
    expect(result.scenarios).toEqual([cliScenario()]);
    expect(result.runMeta.cost.inputTokens).toBeGreaterThan(0);
    expect(result.scenariosPath).toContain("scenarios.json");
  });

  it("rejects unknown claim IDs and arbitrary command strings", async () => {
    await expect(
      generateScenarios(
        { diff: "diff", targetType: "cli", claims: [claim()], allowedCommandIds: ["convert"] },
        { transport: transportFor({ ...cliScenario(), steps: [{ op: "exec", command: "rm -rf /" }] }) }
      )
    ).rejects.toThrow("unauthorized command ID");

    await expect(
      generateScenarios(
        { diff: "diff", targetType: "api", claims: [claim()] },
        { transport: transportFor({ ...apiScenario("/item"), claimIds: ["C-invented"] }) }
      )
    ).rejects.toThrow("unknown claim ID");
  });

  it("rejects duplicate scenario IDs before artifacts can be overwritten", async () => {
    await expect(
      generateScenarios(
        { diff: "diff", targetType: "cli", claims: [claim()], allowedCommandIds: ["convert"] },
        {
          transport: async () => ({
            parsed_output: { scenarios: [cliScenario(), cliScenario()] },
            stop_reason: "end_turn",
            usage: usage()
          })
        }
      )
    ).rejects.toThrow("duplicate scenario ID");
  });

  it("rejects operations that are incompatible with the detected target", async () => {
    await expect(
      generateScenarios(
        { diff: "diff", targetType: "cli", claims: [claim()], allowedCommandIds: ["convert"] },
        { transport: transportFor(apiScenario("/item")) }
      )
    ).rejects.toThrow("unsupported request step for cli");
  });
});

describe("Stage 5 probe orchestration", () => {
  for (const defect of ["bad-exit", "stderr-noise", "missing-output"] as const) {
    it(`materializes the CLI ${defect} observation as a reproduced finding`, async () => {
      const result = await runCli(defect);
      expect(result.findings).toMatchObject([{ origin: "stage5", reproduced: true, category: "logic" }]);
      expect(result.evidence).toMatchObject([{ checkKind: "runtime", reproducible: true }]);
    });
  }

  it("leaves a CLI timeout unverified without creating a flaky finding", async () => {
    const result = await runCli("hang");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toMatchObject([{ reproducible: false }]);
    expect(result.claims[0]?.evidenceIds).toEqual([]);
  });

  it("adds runtime evidence for a clean CLI run without false positives", async () => {
    const result = await runCli("");
    expect(result.findings).toEqual([]);
    expect(result.claims[0]?.evidenceIds).toEqual(["E-S5-1"]);
  });

  for (const testCase of [
    {
      defect: "authz-gap",
      scenario: apiScenario("/admin", {
        method: "POST",
        status: 401,
        failCategory: "security" as const
      }),
      category: "security"
    },
    {
      defect: "schema-drift",
      scenario: apiScenario("/item", {
        jsonSchema: { type: "object", required: ["id", "name"] }
      }),
      category: "logic"
    },
    {
      defect: "flaky-500",
      scenario: apiScenario("/health?fail=1"),
      category: "logic"
    }
  ]) {
    it(`materializes the API ${testCase.defect} observation`, async () => {
      const result = await runApi(testCase.defect, testCase.scenario);
      expect(result.findings).toMatchObject([
        { origin: "stage5", reproduced: true, category: testCase.category }
      ]);
    });
  }

  it("keeps a clean API scenario free of false positives", async () => {
    const result = await runApi("", apiScenario("/item", {
      jsonSchema: { type: "object", required: ["id", "name"] }
    }));
    expect(result.findings).toEqual([]);
    expect(result.claims[0]?.evidenceIds).toEqual(["E-S5-1"]);
  });

  it("keeps bounded API response evidence after driver teardown", async () => {
    const result = await runApi("", apiScenario("/item"));
    const artifact = JSON.parse(await readFile(result.probeArtifactPath, "utf8")) as {
      responseArtifacts: Array<{ response: { status: number; body: string } }>;
    };
    expect(artifact.responseArtifacts).toMatchObject([
      { response: { status: 200, body: expect.stringContaining("fixture") } }
    ]);
  });

  it("leaves API timeouts unverified without creating a finding", async () => {
    const result = await runApi("hang", apiScenario("/hang"), 2_000);
    expect(result.findings).toEqual([]);
    expect(result.evidence).toMatchObject([{ reproducible: false }]);
    expect(result.claims[0]?.evidenceIds).toEqual([]);
  });

  it("normalizes loopback ports when suppressing baseline network failures", async () => {
    const result = await runProbeStage({
      driver: observationDriver("api", {
        consoleErrors: [],
        networkFailures: [{ method: "GET", url: "http://127.0.0.1:2222/item", status: 500, failed: true }],
        screenshots: [],
        crashed: false,
        artifacts: []
      }),
      project: { rootDir: "/fixture", files: async () => [] },
      launch: await launchContext("/fixture", "", 100),
      scenarios: [{ ...apiScenario("/item"), steps: [{ op: "wait", forMs: 0 }] }],
      claims: [claim()],
      runMeta: runMeta(),
      baselines: {
        "api--item": {
          consoleErrors: [],
          networkFailures: [{ method: "GET", url: "http://127.0.0.1:1111/item", status: 500, failed: true }],
          screenshots: [],
          crashed: false,
          artifacts: []
        }
      }
    });
    expect(result.findings).toEqual([]);
  });

  it("honors failCategory before the crash fallback", async () => {
    const result = await runProbeStage({
      driver: observationDriver("cli", {
        consoleErrors: [], networkFailures: [], screenshots: [], crashed: true, artifacts: []
      }),
      project: { rootDir: "/fixture", files: async () => [] },
      launch: await launchContext("/fixture", "", 100),
      scenarios: [{ ...cliScenario(), failCategory: "security" }],
      claims: [claim()],
      runMeta: runMeta()
    });
    expect(result.findings).toMatchObject([{ category: "security" }]);
  });

  it("passes reproduced Stage 5 findings through the shared refutation gate and changes the verdict", async () => {
    const clean = await runCli("");
    const defect = await runCli("bad-exit", true);
    const withoutRuntime = judge([claim()], [], [], runMeta());
    const cleanVerdict = judge(clean.claims, clean.findings, clean.evidence, clean.runMeta);
    const defectVerdict = judge(defect.claims, defect.findings, defect.evidence, defect.runMeta);

    expect(withoutRuntime.kind).toBe("conditional");
    expect(cleanVerdict.kind).toBe("mergeable");
    expect(defectVerdict.kind).toBe("not_mergeable");
    expect(defect.findings[0]?.refutation).toMatchObject({
      required: false,
      attempted: false,
      outcome: "skipped"
    });
  });

  it("retries a retryable launch once, then leaves Stage 5 unobserved", async () => {
    let launches = 0;
    const result = await runProbeStage({
      driver: {
        targetType: "cli",
        detect: async () => ({ confidence: 1, launchHint: "fixture" }),
        launch: async () => {
          launches += 1;
          throw new LaunchError("fixture unavailable", { retryable: true });
        }
      },
      project: { rootDir: "/fixture", files: async () => [] },
      launch: await launchContext("/fixture", "", 100),
      scenarios: [cliScenario()],
      claims: [claim()],
      runMeta: runMeta()
    });
    expect(launches).toBe(2);
    expect(result.findings).toEqual([]);
    expect(result.runMeta.stagesSkipped).toMatchObject([
      { stage: 5, reasonCode: "env-failure" }
    ]);
  });
});

async function runCli(defect: string, withRefutation = false) {
  const workdir = await mkdtemp(join(tmpdir(), "verifier-stage5-cli-"));
  const runsRoot = join(workdir, ".verifier", "runs");
  await writeFile(join(workdir, "input.txt"), "hello", "utf8");
  const driver = new CliProbeDriver({
    commands: {
      convert: {
        file: process.execPath,
        args: [cliFixture, "input.txt", "output.txt"],
        captureFiles: ["output.txt"]
      }
    }
  });
  const options = {
    driver,
    project: {
      rootDir: workdir,
      packageJson: { bin: "cli.mjs" },
      files: async () => []
    },
    launch: await launchContext(workdir, defect, 1_000),
    scenarios: [cliScenario()],
    claims: [claim()],
    runMeta: runMeta(),
    runsRoot,
    cliExpectations: {
      "cli-convert": { artifactPaths: ["output.txt"] }
    }
  };
  return withRefutation
    ? await runProbeAndRefuteStage({ ...options, getRelatedCode: () => "fixture" })
    : await runProbeStage(options);
}

async function runApi(defect: string, scenario: Scenario, timeoutMs = 2_000) {
  const workdir = await mkdtemp(join(tmpdir(), "verifier-stage5-api-"));
  const runsRoot = join(workdir, ".verifier", "runs");
  const result = await runProbeStage({
    driver: new ApiProbeDriver({
      launch: { file: process.execPath, args: [apiFixture], readyPath: "/ready" },
      requestRetries: 1
    }),
    project: {
      rootDir: workdir,
      packageJson: { dependencies: { express: "^5" } },
      files: async () => []
    },
    launch: await launchContext(workdir, defect, timeoutMs),
    scenarios: [scenario],
    claims: [claim()],
    runMeta: runMeta(),
    runsRoot
  });
  const evidencePath = result.evidence[0]?.path;
  if (!evidencePath) throw new Error("API probe did not persist evidence");
  return { ...result, probeArtifactPath: join(runsRoot, result.runMeta.runId, evidencePath) };
}

function observationDriver(targetType: "cli" | "api", observation: import("@verifier/core").Observation) {
  return {
    targetType,
    detect: async () => ({ confidence: 1, launchHint: "test" }),
    launch: async () => ({
      interact: async () => [{ stepIndex: 0, ok: true, artifacts: [] }],
      observe: async () => observation,
      teardown: async () => {}
    })
  };
}

function cliScenario(): Scenario {
  return {
    id: "cli-convert",
    description: "Convert an input file.",
    claimIds: ["C-1"],
    steps: [{ op: "exec", command: "convert" }]
  };
}

function apiScenario(
  path: string,
  options: {
    method?: string;
    status?: number;
    jsonSchema?: unknown;
    failCategory?: Scenario["failCategory"];
  } = {}
): Scenario {
  return {
    id: `api-${path.replaceAll(/\W/g, "-")}`,
    description: `Request ${path}.`,
    claimIds: ["C-1"],
    ...(options.failCategory ? { failCategory: options.failCategory } : {}),
    steps: [
      {
        op: "request",
        method: options.method ?? "GET",
        path,
        expect: {
          status: options.status ?? 200,
          ...(options.jsonSchema !== undefined ? { jsonSchema: options.jsonSchema } : {})
        }
      }
    ]
  };
}

function claim(): Claim {
  return {
    id: "C-1",
    statement: "The target behaves correctly at runtime.",
    priority: "must-verify",
    source: { tier: "primary", kind: "issue", ref: "issue:84" },
    plannedChecks: ["runtime"],
    status: "unverified",
    evidenceIds: []
  };
}

function runMeta(): RunMeta {
  return {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    startedAt: "2026-07-19T00:00:00.000Z",
    baseRef: "main",
    headRef: "HEAD",
    trustLevel: "trusted",
    stagesExecuted: [],
    stagesSkipped: [],
    targets: [],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0 },
    durationMs: 0
  };
}

async function launchContext(
  workdir: string,
  defect: string,
  timeoutMs: number
): Promise<LaunchContext> {
  return {
    workdir,
    env: { FIXTURE_DEFECTS: defect },
    ports: await allocator(),
    timeoutMs,
    networkPolicy: { allowedHosts: ["127.0.0.1"] }
  };
}

async function allocator(): Promise<PortAllocator> {
  return {
    acquire: async () =>
      await new Promise<number>((resolvePort, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("could not allocate port"));
            return;
          }
          server.close(() => resolvePort(address.port));
        });
      }),
    release: () => {}
  };
}

function usage() {
  return {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null
  };
}

function transportFor(scenario: Scenario) {
  return async () => ({
    parsed_output: { scenarios: [scenario] },
    stop_reason: "end_turn",
    usage: usage()
  });
}
