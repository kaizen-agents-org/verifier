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
import type { ValidateFunction } from "ajv";
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
const schemaValidators = new Map<string, ValidateFunction>();

type MismatchKind =
  | "step"
  | "crash"
  | "console"
  | "network"
  | "cli-exit"
  | "cli-stderr"
  | "cli-stdout"
  | "cli-artifact"
  | "request-status"
  | "request-body"
  | "request-header"
  | "request-schema"
  | "request-truncated";

interface ScenarioMismatch {
  kind: MismatchKind;
  message: string;
  stepIndex?: number;
}

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
    redactSensitiveValue(generation),
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
    try {
      if (scenarioIds.has(scenario.id)) {
        throw new Error(`Duplicate probe scenario ID: ${scenario.id}`);
      }
      scenarioIds.add(scenario.id);
      assertScenarioClaims(scenario, options.claims);
    } catch (error) {
      await recordUnverifiedScenario(options, evidence, index, scenario, error);
      continue;
    }
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
      const comparison = await compareScenario(
        scenario,
        stepResults,
        observation,
        options.baselines?.[scenario.id],
        options.cliExpectations?.[scenario.id]
      );
      const responseArtifacts = snapshotResponseArtifacts(comparison.responseArtifacts);
      const evidenceId = `E-S5-${index + 1}`;
      const artifactName = `probe-${scenario.id}.json`;
      await writeJsonArtifact(
        options.runMeta.runId,
        artifactName,
        redactProbeArtifact({
          scenario,
          stepResults,
          observation,
          responseArtifacts,
          mismatches: comparison.mismatches.map(({ message }) => message),
          verificationIssues: comparison.verificationIssues
        }),
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
        ? comparison.mismatches
        : comparison.mismatches.filter((mismatch) => mismatchPrecedesTimeout(
            mismatch,
            firstTimedOutStep,
            scenario,
            stepResults
          ));
      const item: Evidence = {
        id: evidenceId,
        kind: options.driver.targetType === "api" ? "network-log" : "command-output",
        checkKind: "runtime",
        summary: materialMismatches.length > 0
          ? `Runtime scenario ${scenario.id} reproduced ${materialMismatches.length} mismatch(es).`
          : timedOut
            ? `Runtime scenario ${scenario.id} timed out and remains unverified.`
            : comparison.verificationIssues.length > 0
              ? `Runtime scenario ${scenario.id} could not be fully verified.`
            : `Runtime scenario ${scenario.id} completed without mismatches.`,
        path: artifactName,
        reproducible: materialMismatches.length > 0 ||
          (!timedOut && comparison.verificationIssues.length === 0)
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
          scenario: materialMismatches.map(({ message }) => message).join("; "),
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
      } else if (!timedOut && comparison.verificationIssues.length === 0) {
        for (const claimId of scenario.claimIds) {
          successfulEvidence.set(claimId, [
            ...new Set([...(successfulEvidence.get(claimId) ?? []), evidenceId])
          ]);
        }
      }
    } catch (error) {
      if (error instanceof LaunchError) {
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
      await recordUnverifiedScenario(options, evidence, index, scenario, error);
    } finally {
      try {
        await session.teardown();
      } catch {
        // Teardown is best-effort and must not discard an already-recorded scenario result.
      }
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
  mismatch: ScenarioMismatch,
  firstTimedOutStep: number,
  scenario: Scenario,
  stepResults: StepResult[]
): boolean {
  if (mismatch.stepIndex !== undefined) return mismatch.stepIndex < firstTimedOutStep;

  if (mismatch.kind === "crash" || mismatch.kind === "console") {
    return stepResults.some(({ stepIndex, error }) =>
      stepIndex < firstTimedOutStep && !error?.startsWith("timeout")
    );
  }

  if (!["cli-exit", "cli-stderr", "cli-stdout", "cli-artifact"].includes(mismatch.kind)) {
    return false;
  }

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
  if (!probe.runMeta.stagesExecuted.includes(5)) {
    const refutation = {
      findings: probe.findings,
      evidence: [],
      runMeta: probe.runMeta
    };
    return { ...probe, refutation };
  }
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
): Promise<{
  mismatches: ScenarioMismatch[];
  responseArtifacts: Map<number, ResponseArtifact>;
  verificationIssues: string[];
}> {
  const mismatches: ScenarioMismatch[] = [];
  const responseArtifacts = new Map<number, ResponseArtifact>();
  const verificationIssues: string[] = [];
  if (observation.crashed && !baseline?.crashed) {
    mismatches.push({ kind: "crash", message: "target crashed" });
  }

  const baselineConsole = new Set((baseline?.consoleErrors ?? []).map(logKey));
  for (const error of observation.consoleErrors) {
    if (!baselineConsole.has(logKey(error))) {
      mismatches.push({ kind: "console", message: `new console error: ${error.text}` });
    }
  }
  const baselineNetwork = new Set((baseline?.networkFailures ?? []).map(networkKey));
  for (const failure of observation.networkFailures) {
    if (!baselineNetwork.has(networkKey(failure))) {
      const stepIndex = requestStepIndexForFailure(failure, scenario, stepResults);
      mismatches.push({
        kind: "network",
        message: `new network failure: ${failure.method} ${failure.url} ${failure.status ?? "network"}`,
        ...(stepIndex !== undefined ? { stepIndex } : {})
      });
    }
  }

  for (const result of stepResults) {
    const step = scenario.steps[result.stepIndex];
    const expectedCliExit = cliExpectation?.exitCode ?? 0;
    const isExpectedCliExit = step?.op === "exec" && result.error === `exit code ${expectedCliExit}`;
    if (!result.ok && !result.error?.startsWith("timeout")) {
      if (!isExpectedCliExit) {
        mismatches.push({
          kind: "step",
          stepIndex: result.stepIndex,
          message: `step ${result.stepIndex} failed: ${result.error ?? "unknown error"}`
        });
      }
    }
    if (step?.op === "request" && step.expect) {
      const artifact = result.artifacts.find(({ kind }) => kind === "log");
      if (!artifact) {
        mismatches.push({
          kind: "step",
          stepIndex: result.stepIndex,
          message: `step ${result.stepIndex} produced no response artifact`
        });
      } else {
        try {
          const response = await readResponseArtifact(artifact.path);
          responseArtifacts.set(result.stepIndex, response);
          mismatches.push(...compareRequestExpectation(result.stepIndex, response, step.expect));
        } catch (error) {
          verificationIssues.push(redactSensitiveText(
            `step ${result.stepIndex} response artifact could not be verified: ${errorMessage(error)}`
          ));
        }
      }
    }
  }

  if (scenario.steps.some(({ op }) => op === "exec")) {
    const expectation = cliExpectation ?? {};
    const expectedExit = expectation.exitCode ?? 0;
    if (observation.exitCode !== undefined && observation.exitCode !== expectedExit) {
      mismatches.push({
        kind: "cli-exit",
        message: `exit code ${observation.exitCode}, expected ${expectedExit}`
      });
    }
    if ((expectation.stderrEmpty ?? true) && (observation.stderr ?? "").length > 0) {
      mismatches.push({ kind: "cli-stderr", message: "stderr was not empty" });
    }
    if (
      expectation.stdoutIncludes !== undefined &&
      !(observation.stdout ?? "").includes(expectation.stdoutIncludes)
    ) {
      mismatches.push({
        kind: "cli-stdout",
        message: `stdout did not include ${expectation.stdoutIncludes}`
      });
    }
    const artifactPaths = new Set(observation.artifacts.map(({ path }) => path));
    for (const expectedPath of expectation.artifactPaths ?? []) {
      if (!artifactPaths.has(expectedPath)) {
        mismatches.push({
          kind: "cli-artifact",
          message: `missing generated file ${expectedPath}`
        });
      }
    }
  }
  const unique = new Map<string, ScenarioMismatch>();
  for (const mismatch of mismatches) {
    const redacted = { ...mismatch, message: redactSensitiveText(mismatch.message) };
    unique.set(`${redacted.kind}\0${redacted.stepIndex ?? ""}\0${redacted.message}`, redacted);
  }
  return { mismatches: [...unique.values()], responseArtifacts, verificationIssues };
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

function snapshotResponseArtifacts(
  artifacts: Map<number, ResponseArtifact>
): Array<{ stepIndex: number; response: ResponseArtifact }> {
  return [...artifacts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([stepIndex, response]) => ({ stepIndex, response }));
}

function compareRequestExpectation(
  stepIndex: number,
  response: ResponseArtifact,
  expectation: RequestExpectation
): ScenarioMismatch[] {
  const mismatches: ScenarioMismatch[] = [];
  if (expectation.status !== undefined && response.status !== expectation.status) {
    mismatches.push({ kind: "request-status", stepIndex, message: `step ${stepIndex} status ${response.status}, expected ${expectation.status}` });
  }
  if (
    expectation.statusAnyOf !== undefined &&
    !expectation.statusAnyOf.includes(response.status)
  ) {
    mismatches.push({ kind: "request-status", stepIndex, message: `step ${stepIndex} status ${response.status}, expected one of ${expectation.statusAnyOf.join(",")}` });
  }
  if (expectation.bodyIncludes !== undefined && !response.body.includes(expectation.bodyIncludes)) {
    mismatches.push({ kind: "request-body", stepIndex, message: `step ${stepIndex} body did not include ${expectation.bodyIncludes}` });
  }
  for (const [name, value] of Object.entries(expectation.headers ?? {})) {
    if (response.headers[name.toLowerCase()] !== value) {
      mismatches.push({ kind: "request-header", stepIndex, message: `step ${stepIndex} header ${name} did not equal ${value}` });
    }
  }
  if (expectation.jsonSchema !== undefined) {
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      mismatches.push({ kind: "request-body", stepIndex, message: `step ${stepIndex} body was not valid JSON` });
      return mismatches;
    }
    mismatches.push(...compareJsonSchema(stepIndex, body, expectation.jsonSchema));
  }
  if (response.truncated) mismatches.push({ kind: "request-truncated", stepIndex, message: `step ${stepIndex} response body was truncated` });
  return mismatches;
}

function compareJsonSchema(stepIndex: number, value: unknown, schema: unknown): ScenarioMismatch[] {
  if (!isRecord(schema) && typeof schema !== "boolean") {
    return [{ kind: "request-schema", stepIndex, message: `step ${stepIndex} JSON schema was invalid` }];
  }
  try {
    const key = JSON.stringify(schema);
    let validate = schemaValidators.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      schemaValidators.set(key, validate);
    }
    if (validate(value)) return [];
    const summary = ajv.errorsText(validate.errors, { separator: ", " });
    return [{ kind: "request-schema", stepIndex, message: `step ${stepIndex} response failed JSON schema: ${summary}` }];
  } catch (error) {
    return [{ kind: "request-schema", stepIndex, message: `step ${stepIndex} JSON schema was invalid: ${errorMessage(error)}` }];
  }
}

function requestStepIndexForFailure(
  failure: Observation["networkFailures"][number],
  scenario: Scenario,
  stepResults: StepResult[]
): number | undefined {
  let failurePath: string;
  try {
    const url = new URL(failure.url);
    failurePath = `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
  return stepResults.find(({ stepIndex }) => {
    const step = scenario.steps[stepIndex];
    return step?.op === "request" && step.method.toUpperCase() === failure.method.toUpperCase() &&
      step.path === failurePath;
  })?.stepIndex;
}

async function recordUnverifiedScenario(
  options: RunProbeStageOptions,
  evidence: Evidence[],
  index: number,
  scenario: Scenario,
  error: unknown
): Promise<void> {
  const evidenceId = `E-S5-${index + 1}`;
  const artifactName = `probe-unverified-${index + 1}.json`;
  const reason = redactSensitiveText(errorMessage(error));
  await writeJsonArtifact(
    options.runMeta.runId,
    artifactName,
    redactSensitiveValue({ scenario, verificationIssue: reason }),
    options.runsRoot ?? join(options.launch.workdir, ".verifier", "runs")
  );
  evidence.push({
    id: evidenceId,
    kind: options.driver.targetType === "api" ? "network-log" : "command-output",
    checkKind: "runtime",
    summary: `Runtime scenario ${scenario.id} remained unverified: ${reason}`,
    path: artifactName,
    reproducible: false
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  verificationIssues: string[];
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
