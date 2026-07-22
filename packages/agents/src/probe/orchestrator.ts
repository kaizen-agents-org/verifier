import {
  deriveSeverity,
  redactSensitiveText,
  redactSensitiveValue,
  type Claim,
  type Evidence,
  type Finding,
  type ReproCommandAuthorizer,
  type ReproCommandExecutor,
  type RunMeta
} from "@verifier/core";
import {
  LaunchError,
  type LaunchContext,
  type Observation,
  type ProbeDriver,
  type ProbeSession,
  type ProjectContext,
  type RequestExpectation,
  type Scenario,
  type StepResult
} from "@verifier/probe-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { recordAgentUsage } from "../cost.js";
import { writeJsonArtifact } from "../evidence-store.js";
import { runRefutationStage, type RefutationStageResult } from "../orchestrator.js";
import {
  generateScenarios,
  type ScenarioGeneratorInput,
  type ScenarioGeneratorTransport
} from "../scenario/client.js";

const RESPONSE_ARTIFACT_LIMIT = 512 * 1024;
const ajv = new Ajv2020({ allErrors: true, strict: false });

export interface CliScenarioExpectation {
  exitCode?: number;
  stderrEmpty?: boolean;
  stdoutIncludes?: string;
  artifactPaths?: string[];
}

export interface ProbeStageResult {
  claims: Claim[];
  findings: Finding[];
  evidence: Evidence[];
  runMeta: RunMeta;
  observations: Array<{
    scenario: Scenario;
    stepResults: StepResult[];
    observation: Observation;
  }>;
}

export interface RunScenarioGenerationStageOptions {
  runsRoot?: string;
  transport?: ScenarioGeneratorTransport;
}

export async function runScenarioGenerationStage(
  input: ScenarioGeneratorInput,
  runMeta: RunMeta,
  options: RunScenarioGenerationStageOptions = {}
): Promise<{ scenarios: Scenario[]; runMeta: RunMeta; scenariosPath: string }> {
  const { generation, usage } = await generateScenarios(
    input,
    options.transport ? { transport: options.transport } : {}
  );
  const scenariosPath = await writeJsonArtifact(
    runMeta.runId,
    "scenarios.json",
    generation,
    options.runsRoot
  );
  return {
    scenarios: JSON.parse(JSON.stringify(generation.scenarios)) as Scenario[],
    runMeta: recordAgentUsage(runMeta, usage),
    scenariosPath
  };
}

export interface RunProbeStageOptions {
  driver: ProbeDriver;
  project: ProjectContext;
  launch: LaunchContext;
  scenarios: Scenario[];
  claims: Claim[];
  runMeta: RunMeta;
  runsRoot?: string;
  baselines?: Record<string, Observation>;
  cliExpectations?: Record<string, CliScenarioExpectation>;
}

export async function runProbeStage(options: RunProbeStageOptions): Promise<ProbeStageResult> {
  const detection = await options.driver.detect(options.project);
  if (!detection) {
    return {
      claims: options.claims,
      findings: [],
      evidence: [],
      observations: [],
      runMeta: skipStage(options.runMeta, "No compatible probe driver detected.")
    };
  }

  const findings: Finding[] = [];
  const evidence: Evidence[] = [];
  const observations: ProbeStageResult["observations"] = [];
  const successfulEvidence = new Map<string, string[]>();
  const scenarioIds = new Set<string>();

  for (let index = 0; index < options.scenarios.length; index += 1) {
    const scenario = options.scenarios[index];
    if (!scenario) continue;
    if (scenarioIds.has(scenario.id)) {
      throw new Error(`Duplicate probe scenario ID: ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);
    assertScenarioClaims(scenario, options.claims);
    let session: ProbeSession;
    try {
      session = await launchWithRetry(options.driver, options.launch);
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      return {
        claims: options.claims.map((claim) => ({
          ...claim,
          evidenceIds: [
            ...new Set([...claim.evidenceIds, ...(successfulEvidence.get(claim.id) ?? [])])
          ]
        })),
        findings,
        evidence,
        observations,
        runMeta: skipStage(
          options.runMeta,
          `Probe launch failed: ${redactSensitiveText(error.message)}`
        )
      };
    }
    try {
      const stepResults = await session.interact(scenario);
      const observation = await session.observe();
      const mismatches = await compareScenario(
        scenario,
        stepResults,
        observation,
        options.baselines?.[scenario.id],
        options.cliExpectations?.[scenario.id]
      );
      const responseArtifacts = await snapshotResponseArtifacts(scenario, stepResults);
      const evidenceId = `E-S5-${index + 1}`;
      const artifactName = `probe-${scenario.id}.json`;
      await writeJsonArtifact(
        options.runMeta.runId,
        artifactName,
        redactProbeArtifact({ scenario, stepResults, observation, responseArtifacts, mismatches }),
        options.runsRoot ?? join(options.launch.workdir, ".verifier", "runs")
      );
      const timedOutSteps = new Set(
        stepResults
          .filter(({ error }) => error?.startsWith("timeout"))
          .map(({ stepIndex }) => stepIndex)
      );
      const timedOut = timedOutSteps.size > 0;
      const firstTimedOutStep = timedOut ? Math.min(...timedOutSteps) : undefined;
      const materialMismatches = firstTimedOutStep === undefined
        ? mismatches
        : mismatches.filter((mismatch) => mismatchPrecedesTimeout(
            mismatch,
            firstTimedOutStep,
            scenario,
            stepResults,
            observation
          ));
      const item: Evidence = {
        id: evidenceId,
        kind: options.driver.targetType === "api" ? "network-log" : "command-output",
        checkKind: "runtime",
        summary: materialMismatches.length > 0
          ? `Runtime scenario ${scenario.id} reproduced ${materialMismatches.length} mismatch(es).`
          : timedOut
            ? `Runtime scenario ${scenario.id} timed out and remains unverified.`
            : `Runtime scenario ${scenario.id} completed without mismatches.`,
        path: artifactName,
        reproducible: materialMismatches.length > 0 || !timedOut
      };
      evidence.push(item);
      observations.push(redactSensitiveValue({ scenario, stepResults, observation }));

      if (materialMismatches.length > 0) {
        const category = scenario.failCategory ?? (observation.crashed ? "crash" : "logic");
        findings.push({
          id: `F-S5-${index + 1}`,
          category,
          reproduced: true,
          severity: deriveSeverity({ category, reproduced: true }, false),
          title: `Runtime scenario failed: ${scenario.description}`,
          scenario: materialMismatches.join("; "),
          claimIds: [...scenario.claimIds],
          evidenceIds: [evidenceId],
          refutation: {
            required: true,
            attempted: false,
            outcome: "skipped",
            evidenceIds: []
          },
          origin: "stage5"
        });
      } else if (!timedOut) {
        for (const claimId of scenario.claimIds) {
          successfulEvidence.set(claimId, [
            ...new Set([...(successfulEvidence.get(claimId) ?? []), evidenceId])
          ]);
        }
      }
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      return {
        claims: options.claims.map((claim) => ({
          ...claim,
          evidenceIds: [
            ...new Set([...claim.evidenceIds, ...(successfulEvidence.get(claim.id) ?? [])])
          ]
        })),
        findings,
        evidence,
        observations,
        runMeta: skipStage(
          options.runMeta,
          `Probe launch failed: ${redactSensitiveText(error.message)}`
        )
      };
    } finally {
      await session.teardown();
    }
  }

  const claims = options.claims.map((claim) => ({
    ...claim,
    evidenceIds: [...new Set([...claim.evidenceIds, ...(successfulEvidence.get(claim.id) ?? [])])]
  }));
  return {
    claims,
    findings,
    evidence,
    observations,
    runMeta: withStageAndTarget(options.runMeta, options.driver.targetType)
  };
}

function mismatchPrecedesTimeout(
  mismatch: string,
  firstTimedOutStep: number,
  scenario: Scenario,
  stepResults: StepResult[],
  observation: Observation
): boolean {
  const indexedMismatch = /^step (\d+) /.exec(mismatch);
  if (indexedMismatch) return Number(indexedMismatch[1]) < firstTimedOutStep;

  if (mismatch.startsWith("new network failure: ")) {
    return observation.networkFailures.some((failure) =>
      `new network failure: ${failure.method} ${failure.url} ${failure.status ?? "network"}` === mismatch &&
      stepResults.some(({ stepIndex, error }) => {
        const step = scenario.steps[stepIndex];
        if (stepIndex >= firstTimedOutStep || step?.op !== "request" || error?.startsWith("timeout")) {
          return false;
        }
        try {
          const failureUrl = new URL(failure.url);
          return failure.method === step.method && `${failureUrl.pathname}${failureUrl.search}` === step.path;
        } catch {
          return false;
        }
      })
    );
  }

  if (mismatch === "target crashed" || mismatch.startsWith("new console error: ")) {
    return stepResults.some(({ stepIndex, error }) =>
      stepIndex < firstTimedOutStep && !error?.startsWith("timeout")
    );
  }

  const isCliExpectationMismatch = mismatch.startsWith("exit code ") ||
    mismatch === "stderr was not empty" ||
    mismatch.startsWith("stdout did not include ") ||
    mismatch.startsWith("missing generated file ");
  if (!isCliExpectationMismatch) return false;

  return stepResults.some(({ stepIndex, error }) =>
    stepIndex < firstTimedOutStep &&
    scenario.steps[stepIndex]?.op === "exec" &&
    !error?.startsWith("timeout")
  );
}

export interface RunProbeAndRefuteStageOptions extends RunProbeStageOptions {
  getRelatedCode: (finding: Finding) => string;
  authorizeCommand?: ReproCommandAuthorizer;
  executor?: ReproCommandExecutor;
  refutationTransport?: Parameters<typeof runRefutationStage>[2]["transport"];
  refutationTimeoutMs?: number;
  refutationMaxOutputBytes?: number;
}

export async function runProbeAndRefuteStage(
  options: RunProbeAndRefuteStageOptions
): Promise<ProbeStageResult & { refutation: RefutationStageResult }> {
  const probe = await runProbeStage(options);
  const refutation = await runRefutationStage(probe.findings, probe.runMeta, {
    workspace: options.launch.workdir,
    getRelatedCode: options.getRelatedCode,
    stage: 5,
    evidencePrefix: "E-S5-R",
    ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
    ...(options.authorizeCommand ? { authorizeCommand: options.authorizeCommand } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.refutationTransport ? { transport: options.refutationTransport } : {}),
    ...(options.refutationTimeoutMs !== undefined
      ? { timeoutMs: options.refutationTimeoutMs }
      : {}),
    ...(options.refutationMaxOutputBytes !== undefined
      ? { maxOutputBytes: options.refutationMaxOutputBytes }
      : {})
  });
  return {
    ...probe,
    findings: refutation.findings,
    evidence: [...probe.evidence, ...refutation.evidence],
    runMeta: refutation.runMeta,
    refutation
  };
}

async function compareScenario(
  scenario: Scenario,
  stepResults: StepResult[],
  observation: Observation,
  baseline: Observation | undefined,
  cliExpectation: CliScenarioExpectation | undefined
): Promise<string[]> {
  const mismatches: string[] = [];
  if (observation.crashed) mismatches.push("target crashed");

  const baselineConsole = new Set((baseline?.consoleErrors ?? []).map(logKey));
  for (const error of observation.consoleErrors) {
    if (!baselineConsole.has(logKey(error))) mismatches.push(`new console error: ${error.text}`);
  }
  const baselineNetwork = new Set((baseline?.networkFailures ?? []).map(networkKey));
  for (const failure of observation.networkFailures) {
    if (!baselineNetwork.has(networkKey(failure))) {
      mismatches.push(`new network failure: ${failure.method} ${failure.url} ${failure.status ?? "network"}`);
    }
  }

  for (const result of stepResults) {
    const step = scenario.steps[result.stepIndex];
    const expectedCliExit = cliExpectation?.exitCode ?? 0;
    const isExpectedCliExit = step?.op === "exec" && result.error === `exit code ${expectedCliExit}`;
    if (!result.ok && !result.error?.startsWith("timeout")) {
      if (!isExpectedCliExit) {
        mismatches.push(`step ${result.stepIndex} failed: ${result.error ?? "unknown error"}`);
      }
    }
    if (step?.op === "request" && step.expect) {
      const artifact = result.artifacts.find(({ kind }) => kind === "log");
      if (!artifact) {
        mismatches.push(`step ${result.stepIndex} produced no response artifact`);
      } else {
        const response = await readResponseArtifact(artifact.path);
        mismatches.push(...compareRequestExpectation(result.stepIndex, response, step.expect));
      }
    }
  }

  if (scenario.steps.some(({ op }) => op === "exec")) {
    const expectation = cliExpectation ?? {};
    const expectedExit = expectation.exitCode ?? 0;
    if (observation.exitCode !== undefined && observation.exitCode !== expectedExit) {
      mismatches.push(`exit code ${observation.exitCode}, expected ${expectedExit}`);
    }
    if ((expectation.stderrEmpty ?? true) && (observation.stderr ?? "").length > 0) {
      mismatches.push("stderr was not empty");
    }
    if (
      expectation.stdoutIncludes !== undefined &&
      !(observation.stdout ?? "").includes(expectation.stdoutIncludes)
    ) {
      mismatches.push(`stdout did not include ${expectation.stdoutIncludes}`);
    }
    const artifactPaths = new Set(observation.artifacts.map(({ path }) => path));
    for (const expectedPath of expectation.artifactPaths ?? []) {
      if (!artifactPaths.has(expectedPath)) mismatches.push(`missing generated file ${expectedPath}`);
    }
  }
  return [...new Set(mismatches.map((mismatch) => redactSensitiveText(mismatch)))];
}

interface ResponseArtifact {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

async function readResponseArtifact(path: string): Promise<ResponseArtifact> {
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > RESPONSE_ARTIFACT_LIMIT) {
    throw new Error(`Probe response artifact exceeds ${RESPONSE_ARTIFACT_LIMIT} bytes.`);
  }
  return JSON.parse(content) as ResponseArtifact;
}

async function snapshotResponseArtifacts(
  scenario: Scenario,
  stepResults: StepResult[]
): Promise<Array<{ stepIndex: number; response: ResponseArtifact }>> {
  const snapshots: Array<{ stepIndex: number; response: ResponseArtifact }> = [];
  for (const result of stepResults) {
    if (scenario.steps[result.stepIndex]?.op !== "request") continue;
    const artifact = result.artifacts.find(({ kind }) => kind === "log");
    if (!artifact) continue;
    snapshots.push({ stepIndex: result.stepIndex, response: await readResponseArtifact(artifact.path) });
  }
  return snapshots;
}

function compareRequestExpectation(
  stepIndex: number,
  response: ResponseArtifact,
  expectation: RequestExpectation
): string[] {
  const mismatches: string[] = [];
  if (expectation.status !== undefined && response.status !== expectation.status) {
    mismatches.push(`step ${stepIndex} status ${response.status}, expected ${expectation.status}`);
  }
  if (
    expectation.statusAnyOf !== undefined &&
    !expectation.statusAnyOf.includes(response.status)
  ) {
    mismatches.push(
      `step ${stepIndex} status ${response.status}, expected one of ${expectation.statusAnyOf.join(",")}`
    );
  }
  if (expectation.bodyIncludes !== undefined && !response.body.includes(expectation.bodyIncludes)) {
    mismatches.push(`step ${stepIndex} body did not include ${expectation.bodyIncludes}`);
  }
  for (const [name, value] of Object.entries(expectation.headers ?? {})) {
    if (response.headers[name.toLowerCase()] !== value) {
      mismatches.push(`step ${stepIndex} header ${name} did not equal ${value}`);
    }
  }
  if (expectation.jsonSchema !== undefined) {
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      mismatches.push(`step ${stepIndex} body was not valid JSON`);
      return mismatches;
    }
    mismatches.push(...compareJsonSchema(stepIndex, body, expectation.jsonSchema));
  }
  if (response.truncated) mismatches.push(`step ${stepIndex} response body was truncated`);
  return mismatches;
}

function compareJsonSchema(stepIndex: number, value: unknown, schema: unknown): string[] {
  if (!isRecord(schema) && typeof schema !== "boolean") {
    return [`step ${stepIndex} JSON schema was invalid`];
  }
  try {
    const validate = ajv.compile(schema);
    if (validate(value)) return [];
    const summary = ajv.errorsText(validate.errors, { separator: ", " });
    return [`step ${stepIndex} response failed JSON schema: ${summary}`];
  } catch (error) {
    return [
      `step ${stepIndex} JSON schema was invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    ];
  }
}

async function launchWithRetry(driver: ProbeDriver, context: LaunchContext) {
  try {
    return await driver.launch(context);
  } catch (error) {
    if (!(error instanceof LaunchError) || !error.retryable) throw error;
    return await driver.launch(context);
  }
}

function assertScenarioClaims(scenario: Scenario, claims: Claim[]): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(scenario.id)) {
    throw new Error(`Invalid probe scenario ID: ${scenario.id}`);
  }
  const known = new Set(claims.map(({ id }) => id));
  const unknown = scenario.claimIds.find((id) => !known.has(id));
  if (unknown) throw new Error(`Probe scenario returned unknown claim ID: ${unknown}`);
}

function redactProbeArtifact(value: {
  scenario: Scenario;
  stepResults: StepResult[];
  observation: Observation;
  responseArtifacts: Array<{ stepIndex: number; response: ResponseArtifact }>;
  mismatches: string[];
}) {
  return redactSensitiveValue(value);
}

function logKey(entry: Observation["consoleErrors"][number]): string {
  return `${entry.level}\0${entry.text}\0${entry.source ?? ""}`;
}

function networkKey(entry: Observation["networkFailures"][number]): string {
  let target = entry.url;
  try {
    const url = new URL(entry.url);
    target = `${url.pathname}${url.search}`;
  } catch {
    // Preserve non-URL driver identifiers as-is.
  }
  return `${entry.method}\0${target}\0${entry.status ?? ""}\0${entry.failed}`;
}

function withStageAndTarget(runMeta: RunMeta, target: RunMeta["targets"][number]): RunMeta {
  return {
    ...runMeta,
    stagesExecuted: runMeta.stagesExecuted.includes(5)
      ? runMeta.stagesExecuted
      : [...runMeta.stagesExecuted, 5],
    targets: runMeta.targets.includes(target) ? runMeta.targets : [...runMeta.targets, target]
  };
}

function skipStage(runMeta: RunMeta, reason: string): RunMeta {
  return {
    ...runMeta,
    stagesSkipped: [
      ...runMeta.stagesSkipped,
      { stage: 5, reasonCode: "env-failure", reason }
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
