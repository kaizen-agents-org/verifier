import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LaunchError,
  UnsupportedStepError,
  type Artifact,
  type DetectResult,
  type LaunchContext,
  type LogEntry,
  type NetworkEntry,
  type Observation,
  type ProbeDriver,
  type ProbeSession,
  type ProjectContext,
  type Scenario,
  type StepResult
} from "@verifier/probe-sdk";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUEST_PATH_LENGTH = 2_048;
const MAX_HEADER_BYTES = 16 * 1024;
const SAFE_PARENT_ENV_KEYS = [
  "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"
] as const;

export interface ApiLaunchDescriptor {
  file: string;
  args?: string[];
  readyPath?: string;
  hostname?: "127.0.0.1" | "localhost";
}

export interface ApiProbeDriverOptions {
  launch: ApiLaunchDescriptor;
  maxBodyBytes?: number;
  requestRetries?: number;
  maxRequestBytes?: number;
}

export class ApiProbeDriver implements ProbeDriver {
  readonly targetType = "api" as const;

  constructor(private readonly options: ApiProbeDriverOptions) {}

  async detect(ctx: ProjectContext): Promise<DetectResult | null> {
    const dependencies = {
      ...asRecord(ctx.packageJson?.dependencies),
      ...asRecord(ctx.packageJson?.devDependencies)
    };
    if ("express" in dependencies || "fastify" in dependencies || "hono" in dependencies) {
      return { confidence: 0.95, launchHint: "JavaScript HTTP server dependency" };
    }
    const pythonEntries = [
      ...(await ctx.files("**/main.py")),
      ...(await ctx.files("**/app.py"))
    ];
    if (pythonEntries.length > 0) {
      return { confidence: 0.75, launchHint: "Python API entry point" };
    }
    return { confidence: 0.6, launchHint: "caller-authorized API launch descriptor" };
  }

  async launch(ctx: LaunchContext): Promise<ProbeSession> {
    if (ctx.timeoutMs <= 0) throw new LaunchError("API probe timeout must be positive.");
    const hostname = this.options.launch.hostname ?? "127.0.0.1";
    if (!ctx.networkPolicy.allowedHosts.includes(hostname)) {
      throw new LaunchError(`API probe host is not allowed by network policy: ${hostname}`);
    }
    const port = await ctx.ports.acquire();
    const tempDir = await mkdtemp(join(tmpdir(), "verifier-api-probe-"));
    const child = spawn(this.options.launch.file, this.options.launch.args ?? [], {
      cwd: ctx.workdir,
      env: { ...probeEnvironment(ctx.env), HOST: hostname, PORT: String(port) },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const session = new ApiProbeSession(ctx, this.options, child, hostname, port, tempDir);
    try {
      await session.waitUntilReady();
      return session;
    } catch (error) {
      await session.teardown();
      throw error;
    }
  }
}

function probeEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PARENT_ENV_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...overrides };
}

class ApiProbeSession implements ProbeSession {
  private tornDown = false;
  private responseIndex = 0;
  private consoleBytes = 0;
  private launchFailure: Error | undefined;
  private readonly networkFailures: NetworkEntry[] = [];
  private readonly consoleErrors: LogEntry[] = [];
  private readonly artifacts: Artifact[] = [];
  private readonly deadline: number;

  constructor(
    private readonly context: LaunchContext,
    private readonly options: ApiProbeDriverOptions,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly hostname: string,
    private readonly port: number,
    private readonly tempDir: string
  ) {
    this.deadline = Date.now() + context.timeoutMs;
    child.once("error", (error) => {
      this.launchFailure = error;
    });
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      const remaining = Math.max(
        0,
        (this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) - this.consoleBytes
      );
      if (remaining === 0) return;
      const value = bounded(text, remaining);
      this.consoleBytes += Buffer.byteLength(value);
      this.consoleErrors.push({
        level: "error",
        text: value,
        source: "api-server",
        timestamp: new Date().toISOString()
      });
    });
  }

  async waitUntilReady(): Promise<void> {
    const path = this.options.launch.readyPath ?? "/health";
    while (this.remainingMs() > 0) {
      if (this.launchFailure) {
        throw new LaunchError("API server process could not be started.", {
          cause: this.launchFailure
        });
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new LaunchError("API server exited before becoming ready.");
      }
      try {
        const response = await fetch(this.url(path), {
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(500, Math.max(1, this.remainingMs())))
        });
        await response.body?.cancel();
        if (response.status < 500) return;
      } catch {
        // Poll until the bounded launch deadline.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new LaunchError("API server did not become ready before timeout.", { retryable: true });
  }

  async interact(scenario: Scenario): Promise<StepResult[]> {
    this.assertActive();
    const results: StepResult[] = [];
    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      if (!step) continue;
      if (step.op === "wait") {
        if (step.until !== undefined) {
          throw new UnsupportedStepError(step, "API driver does not support wait-until conditions.");
        }
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
      if (step.op !== "request") {
        throw new UnsupportedStepError(step, `API driver does not support ${step.op}.`);
      }
      results.push(await this.request(index, step));
    }
    return results;
  }

  async observe(): Promise<Observation> {
    this.assertActive();
    return {
      consoleErrors: structuredClone(this.consoleErrors),
      networkFailures: structuredClone(this.networkFailures),
      screenshots: [],
      crashed: this.child.exitCode !== null || this.child.signalCode !== null,
      artifacts: structuredClone(this.artifacts)
    };
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    if (!this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform !== "win32" && this.child.pid) {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      } else {
        this.child.kill("SIGKILL");
      }
    }
    this.context.ports.release(this.port);
    await rm(this.tempDir, { recursive: true, force: true });
  }

  private async request(
    stepIndex: number,
    step: Extract<Scenario["steps"][number], { op: "request" }>
  ): Promise<StepResult> {
    if (!step.path.startsWith("/") || step.path.startsWith("//")) {
      throw new UnsupportedStepError(step, "API request path must be relative to the authorized origin.");
    }
    if (step.path.length > MAX_REQUEST_PATH_LENGTH) {
      throw new UnsupportedStepError(step, `API request path exceeds ${MAX_REQUEST_PATH_LENGTH} characters.`);
    }
    let requestBody: string | undefined;
    try {
      requestBody = step.body === undefined ? undefined : JSON.stringify(step.body);
    } catch (error) {
      throw new UnsupportedStepError(step, "API request body is not JSON serializable.", {
        cause: error
      });
    }
    const maxRequestBytes = this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (requestBody !== undefined && Buffer.byteLength(requestBody) > maxRequestBytes) {
      throw new UnsupportedStepError(step, `API request body exceeds ${maxRequestBytes} bytes.`);
    }
    const headerBytes = Object.entries(step.headers ?? {}).reduce(
      (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
      0
    );
    if (headerBytes > MAX_HEADER_BYTES) {
      throw new UnsupportedStepError(step, `API request headers exceed ${MAX_HEADER_BYTES} bytes.`);
    }
    const retries = Math.max(0, Math.min(this.options.requestRetries ?? 1, 2));
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const remainingMs = this.remainingMs();
      if (remainingMs === 0) {
        lastError = this.timeoutError();
        break;
      }
      try {
        const response = await fetch(this.url(step.path), {
          method: step.method.toUpperCase(),
          headers: {
            ...(step.body !== undefined ? { "content-type": "application/json" } : {}),
            ...step.headers
          },
          ...(requestBody !== undefined ? { body: requestBody } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(remainingMs)
        });
        const body = await readBoundedBody(
          response,
          this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
        );
        const artifact = await this.writeResponseArtifact(response, body.text, body.truncated);
        const unexpectedServerError = response.status >= 500 && !isExpectedStatus(step, response.status);
        if (unexpectedServerError) {
          this.networkFailures.push({
            method: step.method.toUpperCase(),
            url: this.url(step.path),
            status: response.status,
            failed: true
          });
          lastError = `HTTP ${response.status}`;
          if (attempt < retries) continue;
        }
        return {
          stepIndex,
          ok: !unexpectedServerError,
          ...(unexpectedServerError && lastError ? { error: lastError } : {}),
          artifacts: [artifact]
        };
      } catch (error) {
        lastError = this.remainingMs() === 0
          ? this.timeoutError()
          : error instanceof Error
            ? error.message
            : String(error);
        this.networkFailures.push({
          method: step.method.toUpperCase(),
          url: this.url(step.path),
          failed: true
        });
        if (attempt >= retries || lastError.startsWith("timeout")) break;
      }
    }
    return { stepIndex, ok: false, error: lastError ?? "network failure", artifacts: [] };
  }

  private async writeResponseArtifact(
    response: Response,
    body: string,
    truncated: boolean
  ): Promise<Artifact> {
    this.responseIndex += 1;
    const path = join(this.tempDir, `response-${this.responseIndex}.json`);
    await writeFile(
      path,
      `${JSON.stringify(
        {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          truncated
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const artifact: Artifact = { kind: "log", path };
    this.artifacts.push(artifact);
    return artifact;
  }

  private url(path: string): string {
    const url = new URL(path, `http://${this.hostname}:${this.port}`);
    if (url.hostname !== this.hostname || url.port !== String(this.port) || url.protocol !== "http:") {
      throw new LaunchError("API request escaped the authorized origin.");
    }
    return url.toString();
  }

  private assertActive(): void {
    if (this.tornDown) throw new LaunchError("API probe session has already been torn down.");
  }

  private remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private timeoutError(): string {
    return `timeout after ${this.context.timeoutMs}ms scenario budget`;
  }
}

function isExpectedStatus(
  step: Extract<Scenario["steps"][number], { op: "request" }>,
  status: number
): boolean {
  const expectation = step.expect;
  if (expectation?.status === undefined && expectation?.statusAnyOf === undefined) return false;
  if (expectation.status !== undefined && expectation.status !== status) return false;
  if (expectation.statusAnyOf !== undefined && !expectation.statusAnyOf.includes(status)) return false;
  return true;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const remaining = Math.max(0, maxBytes - bytes);
    if (result.value.byteLength > remaining) truncated = true;
    if (remaining > 0) {
      const kept = result.value.subarray(0, remaining);
      chunks.push(kept);
      bytes += kept.byteLength;
    }
    if (truncated) {
      await reader.cancel();
      break;
    }
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), truncated };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function bounded(value: string, maxBytes: number): string {
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8");
}
