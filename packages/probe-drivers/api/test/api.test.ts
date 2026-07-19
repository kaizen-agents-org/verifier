import { createServer } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchContext, Observation, PortAllocator, Scenario } from "@verifier/probe-sdk";
import { ApiProbeDriver } from "../src/index.js";

const fixture = resolve(import.meta.dirname, "../../../../fixtures/probe/api-server/server.mjs");

describe("API probe driver", () => {
  it("detects Express projects", async () => {
    const driver = makeDriver();
    await expect(
      driver.detect({
        rootDir: "/repo",
        packageJson: { dependencies: { express: "^5" } },
        files: async () => []
      })
    ).resolves.toMatchObject({ confidence: 0.95 });
  });

  it("observes an authorization gap", async () => {
    const run = await runFixture("authz-gap", requestScenario({
      method: "POST",
      path: "/admin",
      expect: { status: 401 },
      failCategory: "security"
    }));
    expect(run.responses[0]).toMatchObject({ status: 200 });
  });

  it("observes schema drift in the response artifact", async () => {
    const run = await runFixture("schema-drift", requestScenario({
      method: "GET",
      path: "/item",
      expect: {
        status: 200,
        jsonSchema: { type: "object", required: ["id", "name"] }
      }
    }));
    expect(JSON.parse(run.responses[0]?.body ?? "null")).toEqual({ id: 1 });
  });

  it("records the transient 500 and retries once", async () => {
    const run = await runFixture("flaky-500", requestScenario({
      method: "GET",
      path: "/health?fail=1",
      expect: { status: 200 }
    }));
    expect(run.observation.networkFailures).toMatchObject([{ status: 500, failed: true }]);
    expect(run.responses.at(-1)).toMatchObject({ status: 200 });
  });

  it("does not classify an expected 5xx response as a network failure", async () => {
    const run = await runFixture("flaky-500", requestScenario({
      method: "GET",
      path: "/health?fail=1",
      expect: { statusAnyOf: [500, 503] }
    }));
    expect(run.responses).toHaveLength(1);
    expect(run.responses[0]).toMatchObject({ status: 500 });
    expect(run.observation.networkFailures).toEqual([]);
  });

  it("keeps clean requests free of failure observations", async () => {
    const scenario: Scenario = {
      id: "api-clean",
      description: "Exercise clean API flows.",
      claimIds: ["C-1"],
      steps: [
        { op: "request", method: "POST", path: "/admin", expect: { status: 401 } },
        {
          op: "request",
          method: "GET",
          path: "/item",
          expect: { status: 200, jsonSchema: { type: "object", required: ["id", "name"] } }
        },
        { op: "request", method: "GET", path: "/health", expect: { status: 200 } }
      ]
    };
    const run = await runFixture("", scenario);
    expect(run.observation).toMatchObject({ networkFailures: [], consoleErrors: [], crashed: false });
    expect(run.responses.map(({ status }) => status)).toEqual([401, 200, 200]);
  });

  it("rejects paths that can escape the authorized origin", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-api-origin-"));
    const session = await makeDriver().launch(await context(workdir, ""));
    try {
      await expect(
        session.interact(requestScenario({ method: "GET", path: "//example.com/steal" }))
      ).rejects.toThrow("relative to the authorized origin");
    } finally {
      await session.teardown();
      await session.teardown();
    }
  });

  it("rejects oversized scenario-controlled request bodies", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-api-body-"));
    const driver = new ApiProbeDriver({
      launch: { file: process.execPath, args: [fixture], readyPath: "/ready" },
      maxRequestBytes: 4
    });
    const session = await driver.launch(await context(workdir, ""));
    try {
      await expect(
        session.interact({
          ...requestScenario({ method: "POST", path: "/admin" }),
          steps: [{ op: "request", method: "POST", path: "/admin", body: { value: "too large" } }]
        })
      ).rejects.toThrow("request body exceeds 4 bytes");
    } finally {
      await session.teardown();
    }
  });

  it("turns spawn errors into bounded launch failures", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-api-spawn-"));
    const driver = new ApiProbeDriver({
      launch: { file: join(workdir, "missing-server"), readyPath: "/ready" }
    });
    await expect(driver.launch(await context(workdir, ""))).rejects.toThrow(
      "API server process could not be started"
    );
  });

  it("enforces one deadline across launch and all scenario steps", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "verifier-api-deadline-"));
    const session = await makeDriver().launch(await context(workdir, "", 2_000));
    const startedAt = Date.now();
    const results = await session.interact({
      ...requestScenario({ method: "GET", path: "/item" }),
      steps: [{ op: "wait", forMs: 1_300 }, { op: "wait", forMs: 1_300 }]
    });
    expect(results.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("timeout") });
    expect(Date.now() - startedAt).toBeLessThan(2_100);
    await session.teardown();
  });
});

function requestScenario(options: {
  method: string;
  path: string;
  expect?: Extract<Scenario["steps"][number], { op: "request" }>["expect"];
  failCategory?: Scenario["failCategory"];
}): Scenario {
  return {
    id: `api-${options.path.replaceAll(/\W/g, "-")}`,
    description: `Request ${options.path}.`,
    claimIds: ["C-1"],
    ...(options.failCategory ? { failCategory: options.failCategory } : {}),
    steps: [
      {
        op: "request",
        method: options.method,
        path: options.path,
        ...(options.expect ? { expect: options.expect } : {})
      }
    ]
  };
}

async function runFixture(defect: string, scenario: Scenario): Promise<{
  observation: Observation;
  responses: Array<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>;
}> {
  const workdir = await mkdtemp(join(tmpdir(), "verifier-api-fixture-"));
  const session = await makeDriver().launch(await context(workdir, defect));
  try {
    const results = await session.interact(scenario);
    const observation = await session.observe();
    const responses = await Promise.all(
      results.flatMap(({ artifacts }) => artifacts).map(async ({ path }) =>
        JSON.parse(await readFile(path, "utf8")) as {
          status: number;
          headers: Record<string, string>;
          body: string;
          truncated: boolean;
        }
      )
    );
    return { observation, responses };
  } finally {
    await session.teardown();
  }
}

function makeDriver(): ApiProbeDriver {
  return new ApiProbeDriver({
    launch: {
      file: process.execPath,
      args: [fixture],
      readyPath: "/ready"
    },
    requestRetries: 1
  });
}

async function context(workdir: string, defect: string, timeoutMs = 2_000): Promise<LaunchContext> {
  return {
    workdir,
    env: { FIXTURE_DEFECTS: defect },
    ports: await allocator(),
    timeoutMs,
    networkPolicy: { allowedHosts: ["127.0.0.1"] }
  };
}

async function allocator(): Promise<PortAllocator> {
  let released = false;
  return {
    acquire: async () => {
      if (released) throw new Error("allocator already released");
      return await new Promise<number>((resolvePort, reject) => {
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
      });
    },
    release: () => {
      released = true;
    }
  };
}
