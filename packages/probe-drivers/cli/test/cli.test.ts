import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchContext, Observation, Scenario, StepResult } from "@verifier/probe-sdk";
import { CliProbeDriver } from "../src/index.js";

const fixture = resolve(import.meta.dirname, "../../../../fixtures/probe/cli-tool/cli.mjs");

describe("CLI probe driver", () => {
  for (const defect of ["bad-exit", "stderr-noise", "missing-output", "hang"] as const) {
    it(`observes ${defect} through the real fixture`, async () => {
      const { observation, results } = await runFixture(defect);
      if (defect === "bad-exit") expect(observation.exitCode).toBe(1);
      if (defect === "stderr-noise") expect(observation.stderr).toContain("diagnostic noise");
      if (defect === "missing-output") expect(observation.artifacts).toEqual([]);
      if (defect === "hang") {
        expect(results[0]).toMatchObject({ ok: false, error: expect.stringContaining("timeout") });
        expect(observation.crashed).toBe(false);
      }
    });
  }

  it("keeps a clean run free of failure observations", async () => {
    const { observation, results, workdir } = await runFixture("");
    expect(results).toMatchObject([{ ok: true }]);
    expect(observation).toMatchObject({ exitCode: 0, stderr: "", crashed: false });
    expect(observation.artifacts).toEqual([{ kind: "file", path: "output.txt" }]);
    await expect(readFile(join(workdir, "output.txt"), "utf8")).resolves.toBe("HELLO");
  });

  it("detects package and Cargo binaries without side effects", async () => {
    const driver = new CliProbeDriver({ commands: {} });
    await expect(
      driver.detect({ rootDir: "/repo", packageJson: { bin: "cli.js" }, files: async () => [] })
    ).resolves.toMatchObject({ confidence: 0.95 });
    await expect(
      driver.detect({ rootDir: "/repo", files: async (glob) => glob === "Cargo.toml" ? ["Cargo.toml"] : [] })
    ).resolves.toMatchObject({ confidence: 0.8 });
  });

  it("rejects unregistered model-proposed commands without invoking a shell", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-cli-auth-"));
    const driver = new CliProbeDriver({ commands: {} });
    const session = await driver.launch(context(workdir, {}));
    const injected = `unknown; touch ${join(workdir, "pwned")}`;
    await expect(session.interact(scenario(injected))).rejects.toThrow("not authorized");
    await expect(access(join(workdir, "pwned"))).rejects.toThrow();
    await session.teardown();
  });

  it("rejects oversized scenario-controlled stdin", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-cli-input-"));
    const driver = new CliProbeDriver({
      commands: { convert: { file: process.execPath, args: [fixture, "input", "output"] } },
      maxInputBytes: 4
    });
    const session = await driver.launch(context(workdir, {}));
    await expect(
      session.interact({ ...scenario("convert"), steps: [{ op: "exec", command: "convert", stdin: "12345" }] })
    ).rejects.toThrow("stdin exceeds 4 bytes");
    await session.teardown();
  });

  it("enforces one deadline across all scenario steps", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-cli-deadline-"));
    const session = await new CliProbeDriver({ commands: {} }).launch(context(workdir, {}, 100));
    const startedAt = Date.now();
    const results = await session.interact({
      ...scenario("unused"),
      steps: [{ op: "wait", forMs: 70 }, { op: "wait", forMs: 70 }]
    });
    expect(results.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("timeout") });
    expect(Date.now() - startedAt).toBeLessThan(180);
    await session.teardown();
  });
});

async function runFixture(defect: string): Promise<{
  observation: Observation;
  results: StepResult[];
  workdir: string;
}> {
  const workdir = await mkdtemp(join(tmpdir(), "verifier-cli-fixture-"));
  await writeFile(join(workdir, "input.txt"), "hello", "utf8");
  const driver = new CliProbeDriver({
    commands: {
      convert: {
        file: process.execPath,
        args: [fixture, "input.txt", "output.txt"],
        captureFiles: ["output.txt"]
      }
    }
  });
  const session = await driver.launch(
    context(workdir, { FIXTURE_DEFECTS: defect }, defect === "hang" ? 1_000 : 5_000)
  );
  try {
    const results = await session.interact(scenario("convert"));
    const observation = await session.observe();
    return { observation, results, workdir };
  } finally {
    await session.teardown();
  }
}

function context(
  workdir: string,
  env: Record<string, string>,
  timeoutMs = 1_000
): LaunchContext {
  return {
    workdir,
    env,
    ports: { acquire: async () => 0, release: () => {} },
    timeoutMs,
    networkPolicy: { allowedHosts: [] }
  };
}

function scenario(command: string): Scenario {
  return {
    id: "cli-convert",
    description: "Convert an input file.",
    claimIds: ["C-1"],
    steps: [{ op: "exec", command }]
  };
}
