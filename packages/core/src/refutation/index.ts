import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Evidence, Finding } from "../judge/index.js";
import { redactSensitiveText } from "../redaction.js";

const DEFAULT_REPRO_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RefuterOutput {
  outcome: "survived" | "refuted";
  reasoning: string;
  reproCommand?: string;
}

export interface ReproCommandResult {
  command: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface ExecuteReproCommandOptions {
  workspace: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type ReproCommandExecutor = (
  command: string,
  options: ExecuteReproCommandOptions
) => Promise<ReproCommandResult>;

export interface RunRefutationGateOptions extends ExecuteReproCommandOptions {
  runDir: string;
  evidenceId: string;
  allowCommandExecution: boolean;
  executor?: ReproCommandExecutor;
}

export interface RefutationGateResult {
  finding: Finding;
  evidence?: Evidence;
  execution?: ReproCommandResult;
}

export async function runRefutationGate(
  finding: Finding,
  refuterOutput: RefuterOutput,
  options: RunRefutationGateOptions
): Promise<RefutationGateResult> {
  if (finding.reproduced) {
    return {
      finding: {
        ...finding,
        refutation: {
          required: false,
          attempted: false,
          outcome: "skipped",
          notes: "Refutation skipped because the finding already has reproduction evidence.",
          evidenceIds: [...finding.refutation.evidenceIds]
        }
      }
    };
  }

  const command = refuterOutput.reproCommand?.trim();
  if (!command) {
    return {
      finding: withRefuterOutcome(finding, refuterOutput, undefined)
    };
  }
  if (!options.allowCommandExecution) {
    return {
      finding: withRefuterOutcome(
        finding,
        {
          ...refuterOutput,
          reasoning: `${refuterOutput.reasoning} Reproduction command was not executed by policy.`
        },
        undefined
      )
    };
  }

  if (!EVIDENCE_ID_PATTERN.test(options.evidenceId)) {
    throw new Error(`Invalid refutation evidence ID: ${options.evidenceId}`);
  }
  await assertEvidenceDirectory(options.workspace, options.runDir);
  const executor = options.executor ?? executeReproCommand;
  const execution = await executor(command, options);
  const evidencePath = join("evidence", `${options.evidenceId}.txt`);
  const absoluteEvidencePath = resolve(options.runDir, evidencePath);
  await mkdir(resolve(options.runDir, "evidence"), { recursive: true });
  await assertRealPathWithinWorkspace(options.workspace, resolve(options.runDir, "evidence"));
  await writeFile(absoluteEvidencePath, redactSensitiveText(formatExecution(execution)), "utf8");

  const confirmed = execution.code === 0 && !execution.timedOut;
  const evidence: Evidence = {
    id: options.evidenceId,
    kind: "command-output",
    checkKind: "runtime",
    summary: confirmed
      ? "Refuter reproduction command completed successfully."
      : execution.timedOut
        ? `Refuter reproduction command timed out after ${options.timeoutMs ?? DEFAULT_REPRO_TIMEOUT_MS}ms.`
        : `Refuter reproduction command exited with code ${execution.code ?? "null"}.`,
    path: evidencePath,
    reproducible: true,
    command: redactSensitiveText(command)
  };

  return {
    finding: withRefuterOutcome(finding, refuterOutput, {
      confirmed,
      evidenceId: options.evidenceId,
      execution
    }),
    evidence,
    execution
  };
}

export function executeReproCommand(
  command: string,
  options: ExecuteReproCommandOptions
): Promise<ReproCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPRO_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Refutation timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("Refutation output limit must be a positive integer.");
  }

  const workspace = resolve(options.workspace);
  const startedAt = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child.pid);
      killTimer = setTimeout(() => terminateProcessGroup(child.pid, "SIGKILL"), 1_000);
    }, timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const used = target === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxOutputBytes - used);
      if (chunk.byteLength > remaining) outputTruncated = true;
      const kept = remaining > 0 ? chunk.subarray(0, remaining).toString("utf8") : "";
      if (target === "stdout") {
        stdout += kept;
        stdoutBytes += Math.min(chunk.byteLength, remaining);
      } else {
        stderr += kept;
        stderrBytes += Math.min(chunk.byteLength, remaining);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        command,
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTruncated
      });
    });
  });
}

function withRefuterOutcome(
  finding: Finding,
  output: RefuterOutput,
  repro:
    | { confirmed: boolean; evidenceId: string; execution: ReproCommandResult }
    | undefined
): Finding {
  const outcome = repro?.confirmed ? "survived" : output.outcome;
  const evidenceIds = repro
    ? [...new Set([...finding.refutation.evidenceIds, repro.evidenceId])]
    : [...finding.refutation.evidenceIds];
  const executionNote = repro
    ? repro.confirmed
      ? "Reproduction command succeeded; the orchestrator confirmed the finding."
      : repro.execution.timedOut
        ? "Reproduction command timed out; the model outcome was retained."
        : `Reproduction command exited with code ${repro.execution.code ?? "null"}; the model outcome was retained.`
    : undefined;

  return {
    ...finding,
    evidenceIds: repro
      ? [...new Set([...finding.evidenceIds, repro.evidenceId])]
      : [...finding.evidenceIds],
    refutation: {
      required: true,
      attempted: true,
      outcome,
      ...(repro?.confirmed ? { reproConfirmed: true } : {}),
      notes: [output.reasoning, executionNote].filter(Boolean).join(" "),
      evidenceIds
    }
  };
}

async function assertEvidenceDirectory(workspace: string, runDir: string): Promise<void> {
  const resolvedWorkspace = resolve(workspace);
  const resolvedRunDir = resolve(runDir);
  const relativePath = relative(resolvedWorkspace, resolvedRunDir);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Refutation runDir must be a child of the workspace.");
  }

  let ancestor = resolvedRunDir;
  while (!(await pathExists(ancestor))) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  await assertRealPathWithinWorkspace(workspace, ancestor);
}

async function assertRealPathWithinWorkspace(workspace: string, path: string): Promise<void> {
  const [realWorkspace, realTarget] = await Promise.all([realpath(workspace), realpath(path)]);
  const relativePath = relative(realWorkspace, realTarget);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Refutation evidence path resolves outside the workspace.");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function formatExecution(result: ReproCommandResult): string {
  return [
    `$ ${result.command}`,
    result.timedOut
      ? "timed out"
      : `exit code ${result.code ?? "null"}${result.signal ? `; signal ${result.signal}` : ""}`,
    result.outputTruncated ? "output truncated" : "",
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout and signal delivery.
    }
  }
}
