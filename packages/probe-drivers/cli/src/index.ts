import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  LaunchError,
  UnsupportedStepError,
  type Artifact,
  type DetectResult,
  type LaunchContext,
  type Observation,
  type ProbeDriver,
  type ProbeSession,
  type ProjectContext,
  type Scenario,
  type StepResult
} from "@verifier/probe-sdk";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;

export interface CliCommandDescriptor {
  file: string;
  args?: string[];
  captureFiles?: string[];
}

export interface CliProbeDriverOptions {
  commands: Record<string, CliCommandDescriptor>;
  maxOutputBytes?: number;
  maxInputBytes?: number;
}

export class CliProbeDriver implements ProbeDriver {
  readonly targetType = "cli" as const;

  constructor(private readonly options: CliProbeDriverOptions) {}

  async detect(ctx: ProjectContext): Promise<DetectResult | null> {
    const bin = ctx.packageJson?.bin;
    if (typeof bin === "string" || isStringRecord(bin)) {
      return { confidence: 0.95, launchHint: "package.json bin executable" };
    }
    const cargoFiles = await ctx.files("Cargo.toml");
    if (cargoFiles.length > 0) {
      return { confidence: 0.8, launchHint: "Cargo binary target" };
    }
    return Object.keys(this.options.commands).length > 0
      ? { confidence: 0.6, launchHint: "caller-authorized CLI command registry" }
      : null;
  }

  async launch(ctx: LaunchContext): Promise<ProbeSession> {
    if (ctx.timeoutMs <= 0) throw new LaunchError("CLI probe timeout must be positive.");
    return new CliProbeSession(ctx, this.options);
  }
}

class CliProbeSession implements ProbeSession {
  private activeChild: ChildProcessWithoutNullStreams | undefined;
  private tornDown = false;
  private observation: Observation = emptyObservation();
  private readonly deadline: number;

  constructor(
    private readonly context: LaunchContext,
    private readonly options: CliProbeDriverOptions
  ) {
    this.deadline = Date.now() + context.timeoutMs;
  }

  async interact(scenario: Scenario): Promise<StepResult[]> {
    this.assertActive();
    const results: StepResult[] = [];
    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      if (!step) continue;
      if (step.op === "wait") {
        const requestedMs = Math.max(0, step.forMs ?? 0);
        const remainingMs = this.remainingMs();
        const waitMs = Math.min(requestedMs, remainingMs);
        await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        results.push(
          requestedMs > remainingMs
            ? { stepIndex: index, ok: false, error: this.timeoutError(), artifacts: [] }
            : { stepIndex: index, ok: true, artifacts: [] }
        );
        if (requestedMs > remainingMs) break;
        continue;
      }
      if (step.op !== "exec") {
        throw new UnsupportedStepError(step, `CLI driver does not support ${step.op}.`);
      }
      results.push(await this.execute(index, step.command, step.stdin));
    }
    return results;
  }

  async observe(): Promise<Observation> {
    this.assertActive();
    return structuredClone(this.observation);
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    this.stopActiveChild();
  }

  private async execute(stepIndex: number, commandId: string, stdin?: string): Promise<StepResult> {
    const descriptor = this.options.commands[commandId];
    if (!descriptor) {
      throw new UnsupportedStepError(
        { op: "exec", command: commandId, ...(stdin !== undefined ? { stdin } : {}) },
        `CLI command is not authorized: ${commandId}`
      );
    }
    const maxInputBytes = this.options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    if (stdin !== undefined && Buffer.byteLength(stdin) > maxInputBytes) {
      throw new UnsupportedStepError(
        { op: "exec", command: commandId, stdin },
        `CLI stdin exceeds ${maxInputBytes} bytes.`
      );
    }
    if (this.activeChild) throw new LaunchError("CLI probe already has an active child process.");
    const remainingMs = this.remainingMs();
    if (remainingMs === 0) {
      return { stepIndex, ok: false, error: this.timeoutError(), artifacts: [] };
    }

    const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const artifactSnapshot = await snapshotArtifacts(
      this.context.workdir,
      descriptor.captureFiles ?? []
    );
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn(descriptor.file, descriptor.args ?? [], {
      cwd: this.context.workdir,
      env: { ...process.env, ...this.context.env },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.activeChild = child;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const kept = chunk.subarray(0, remaining).toString("utf8");
      outputBytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) truncated = true;
      if (target === "stdout") stdout += kept;
      else stderr += kept;
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveResult, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          this.stopActiveChild();
        }, remainingMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new LaunchError(`Failed to execute CLI command ${commandId}.`, { cause: error }));
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolveResult({ code, signal });
        });
      }
    ).finally(() => {
      this.activeChild = undefined;
    });

    const artifacts = await collectArtifacts(
      this.context.workdir,
      descriptor.captureFiles ?? [],
      artifactSnapshot
    );
    this.observation = {
      ...this.observation,
      ...(result.code !== null ? { exitCode: result.code } : {}),
      stdout: `${this.observation.stdout ?? ""}${stdout}`,
      stderr: `${this.observation.stderr ?? ""}${stderr}`,
      crashed: !timedOut && result.signal !== null,
      artifacts: [...this.observation.artifacts, ...artifacts]
    };

    const error = timedOut
      ? this.timeoutError()
      : truncated
        ? `output exceeded ${maxOutputBytes} bytes`
        : result.code === 0
          ? undefined
          : `exit code ${result.code ?? "null"}`;
    return {
      stepIndex,
      ok: error === undefined,
      ...(error ? { error } : {}),
      artifacts
    };
  }

  private stopActiveChild(): void {
    const child = this.activeChild;
    if (!child || child.killed) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // The process may already have exited between the state check and kill.
      }
    }
    child.kill("SIGKILL");
  }

  private remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private timeoutError(): string {
    return `timeout after ${this.context.timeoutMs}ms scenario budget`;
  }

  private assertActive(): void {
    if (this.tornDown) throw new LaunchError("CLI probe session has already been torn down.");
  }
}

type ArtifactSnapshot = Map<string, string | undefined>;

async function snapshotArtifacts(workdir: string, paths: string[]): Promise<ArtifactSnapshot> {
  const snapshot: ArtifactSnapshot = new Map();
  for (const path of paths) {
    const absolute = resolveArtifactPath(workdir, path);
    snapshot.set(path, await artifactFingerprint(absolute));
  }
  return snapshot;
}

async function collectArtifacts(
  workdir: string,
  paths: string[],
  before: ArtifactSnapshot
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for (const path of paths) {
    const absolute = resolveArtifactPath(workdir, path);
    const after = await artifactFingerprint(absolute);
    if (after !== undefined && after !== before.get(path)) {
      artifacts.push({ kind: "file", path });
    }
  }
  return artifacts;
}

function resolveArtifactPath(workdir: string, path: string): string {
  const absolute = resolve(workdir, path);
  if (isAbsolute(path) || escapes(workdir, absolute)) {
    throw new LaunchError(`CLI artifact path escapes the workdir: ${path}`);
  }
  return absolute;
}

async function artifactFingerprint(path: string): Promise<string | undefined> {
  try {
    const value = await stat(path, { bigint: true });
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function escapes(root: string, candidate: string): boolean {
  const path = relative(resolve(root), candidate);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function emptyObservation(): Observation {
  return {
    consoleErrors: [],
    networkFailures: [],
    screenshots: [],
    crashed: false,
    artifacts: []
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
