import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { evaluateMinimalVerdict } from "./minimal-verdict.js";
import type { FinalVerdictKind, MinimalVerdict, VerdictInput } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CheckInput {
  task: string;
  workspace: string;
  base: string;
  verifyCommands: string[];
  outputDir?: string;
}

export interface CheckResult {
  verdict: MinimalVerdict;
  markdown: string;
}

interface CommandRunResult {
  command: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface EvidenceRecord {
  id: string;
  kind: NonNullable<MinimalVerdict["evidence"]>[number]["kind"];
  path: string;
  summary: string;
}

export async function runCheck(input: CheckInput): Promise<CheckResult> {
  const startedAt = new Date();
  const workspace = resolve(input.workspace);
  const base = input.base;
  const runId = createRunId(startedAt);
  const outputRoot = input.outputDir
    ? resolve(workspace, input.outputDir)
    : join(workspace, ".verifier", "runs");
  const runDir = resolve(outputRoot, runId);

  const [diff, changedFiles, headRef] = await Promise.all([
    readDiff(base, workspace),
    readChangedFiles(base, workspace),
    readHeadRef(workspace)
  ]);
  const commandResults = await runVerifyCommands(input.verifyCommands, workspace);

  const verifyLogs = commandResults.map(formatCommandResult).join("\n\n");
  const builderReport = buildCheckReport(base, workspace, input.verifyCommands);
  const verdictInput: VerdictInput = {
    task: input.task,
    diff,
    verifyLogs,
    builderReport
  };

  const compactVerdict = evaluateMinimalVerdict(verdictInput);
  const finalVerdict = deriveFinalVerdict(compactVerdict, verdictInput, input.verifyCommands);
  const conditions = deriveConditions(compactVerdict, verdictInput, input.verifyCommands);
  const completedAt = new Date();

  await mkdir(runDir, { recursive: true });

  const evidence: EvidenceRecord[] = [];
  if (input.task.trim()) {
    evidence.push(await writeEvidence(runDir, "E-1", "intent", "intent.txt", input.task, "Primary intent supplied to verifier check."));
  }
  evidence.push(await writeEvidence(runDir, "E-2", "diff", "diff.patch", diff, `Git diff against ${base}.`));
  evidence.push(await writeEvidence(runDir, "E-3", "verify_logs", "verify-logs.txt", verifyLogs, "Verification command output."));
  evidence.push(await writeEvidence(runDir, "E-4", "builder_report", "builder-report.md", builderReport, "Verifier check collection report."));

  const verdict: MinimalVerdict = {
    ...compactVerdict,
    final_verdict: finalVerdict,
    conditions,
    summary: summarizeFinalVerdict(finalVerdict, compactVerdict, conditions),
    run: {
      id: runId,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      workspace,
      base_ref: base,
      head_ref: headRef,
      artifacts_dir: runDir,
      changed_files: changedFiles,
      verify_commands: commandResults.map((result) => ({
        command: result.command,
        exit_code: result.code,
        signal: result.signal,
        duration_ms: result.durationMs
      }))
    },
    evidence
  };

  const markdown = renderMarkdownReport(verdict);
  verdict.evidence = [
    ...evidence,
    await writeEvidence(runDir, "E-5", "markdown", "report.md", markdown, "Human-readable verifier report."),
    {
      id: "E-6",
      kind: "verdict",
      path: "verdict.json",
      summary: "Machine-readable verifier verdict."
    }
  ];

  await writeFile(join(runDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");

  return {
    verdict,
    markdown
  };
}

export function shouldFailForVerdict(
  verdict: FinalVerdictKind,
  failOn: FinalVerdictKind | undefined
): boolean {
  if (!failOn) return false;
  if (failOn === "mergeable") return verdict !== "mergeable";
  if (failOn === "conditional") {
    return verdict === "conditional" || verdict === "not_mergeable" || verdict === "inconclusive";
  }
  if (failOn === "inconclusive") {
    return verdict === "inconclusive" || verdict === "not_mergeable";
  }
  return verdict === "not_mergeable";
}

async function readDiff(base: string, workspace: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "diff",
    "--no-ext-diff",
    "--binary",
    base
  ], {
    cwd: workspace,
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout;
}

async function readChangedFiles(base: string, workspace: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", base], {
    cwd: workspace,
    maxBuffer: 1024 * 1024
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function readHeadRef(workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: workspace,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function runVerifyCommands(commands: string[], workspace: string): Promise<CommandRunResult[]> {
  const results: CommandRunResult[] = [];
  for (const command of commands) {
    results.push(await runShellCommand(command, workspace));
  }
  return results;
}

function runShellCommand(command: string, workspace: string): Promise<CommandRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        command,
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function formatCommandResult(result: CommandRunResult): string {
  return [
    `$ ${result.command}`,
    `exit code ${result.code ?? "null"}${result.signal ? ` signal ${result.signal}` : ""}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCheckReport(base: string, workspace: string, verifyCommands: string[]): string {
  return [
    `verifier check collected git diff against ${base} in ${workspace}.`,
    verifyCommands.length
      ? `verifier check ran ${verifyCommands.length} verification command(s).`
      : "No verification commands were run; manual review required."
  ].join("\n");
}

function deriveFinalVerdict(
  verdict: MinimalVerdict,
  input: VerdictInput,
  verifyCommands: string[]
): FinalVerdictKind {
  if (verdict.verdict === "rejected") return "not_mergeable";
  if (!input.diff.trim()) return "inconclusive";
  if (!input.task.trim()) return "conditional";
  if (verifyCommands.length === 0) return "conditional";
  if (verdict.should_fix.length > 0) return "conditional";
  return "mergeable";
}

function deriveConditions(
  verdict: MinimalVerdict,
  input: VerdictInput,
  verifyCommands: string[]
): string[] {
  const conditions: string[] = [];
  if (!input.task.trim()) conditions.push("Provide primary intent with --intent or --intent-file.");
  if (!input.diff.trim()) conditions.push("Provide or create a diff that can be checked against the intent.");
  if (verifyCommands.length === 0) conditions.push("Run at least one verification command.");
  for (const item of verdict.must_fix) {
    conditions.push(item.evidence ? `${item.message} Evidence: ${item.evidence}` : item.message);
  }
  for (const item of verdict.should_fix) {
    conditions.push(item.evidence ? `${item.message} Evidence: ${item.evidence}` : item.message);
  }
  return unique(conditions);
}

function summarizeFinalVerdict(
  finalVerdict: FinalVerdictKind,
  verdict: MinimalVerdict,
  conditions: string[]
): string {
  if (finalVerdict === "mergeable") {
    return `Mergeable with confidence ${verdict.confidence}; risk is ${verdict.risk}.`;
  }
  if (finalVerdict === "not_mergeable") {
    return `Not mergeable with ${verdict.must_fix.length} must_fix item(s); risk is ${verdict.risk}.`;
  }
  if (finalVerdict === "inconclusive") {
    return `Inconclusive with ${conditions.length} condition(s); risk is ${verdict.risk}.`;
  }
  return `Conditional with ${conditions.length} condition(s); risk is ${verdict.risk}.`;
}

function renderMarkdownReport(verdict: MinimalVerdict): string {
  const commandRows = verdict.run?.verify_commands.length
    ? verdict.run.verify_commands
        .map((command) => `| \`${escapePipes(command.command)}\` | ${command.exit_code ?? "null"} | ${command.duration_ms} |`)
        .join("\n")
    : "| _none_ | - | - |";
  const mustFix = renderFindingList(verdict.must_fix);
  const shouldFix = renderFindingList(verdict.should_fix);
  const conditions = verdict.conditions?.length
    ? verdict.conditions.map((condition) => `- ${condition}`).join("\n")
    : "- None";

  return [
    `# Verifier Verdict: ${verdict.final_verdict ?? verdict.verdict}`,
    "",
    `Summary: ${verdict.summary}`,
    "",
    `Confidence: ${verdict.confidence}`,
    `Risk: ${verdict.risk}`,
    `Compatibility verdict: ${verdict.verdict}`,
    verdict.run ? `Artifacts: ${verdict.run.artifacts_dir}` : "",
    "",
    "## Conditions",
    conditions,
    "",
    "## Verification Commands",
    "| Command | Exit code | Duration ms |",
    "|---|---:|---:|",
    commandRows,
    "",
    "## Must Fix",
    mustFix,
    "",
    "## Should Fix",
    shouldFix,
    ""
  ].join("\n");
}

function renderFindingList(items: MinimalVerdict["must_fix"]): string {
  if (items.length === 0) return "- None";
  return items
    .map((item) => {
      const evidence = item.evidence ? ` Evidence: ${item.evidence}` : "";
      return `- [${item.source}] ${item.message}${evidence}`;
    })
    .join("\n");
}

async function writeEvidence(
  runDir: string,
  id: string,
  kind: EvidenceRecord["kind"],
  path: string,
  content: string,
  summary: string
): Promise<EvidenceRecord> {
  await writeFile(join(runDir, path), content, "utf8");
  return { id, kind, path, summary };
}

function createRunId(date: Date): string {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}
