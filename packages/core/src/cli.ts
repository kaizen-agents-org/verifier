#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { runCheck, shouldFailForVerdict } from "./check.js";
import { evaluateMinimalVerdict } from "./minimal-verdict.js";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";
import { KaizenVerifierResultSchema, VerdictInputSchema } from "./types.js";
import type {
  FinalVerdictKind,
  KaizenVerifierResult,
  VerdictDecision,
  VerdictInput,
  VerdictRun
} from "./types.js";
import { readVersionInfo } from "./version.js";

interface CliOptions {
  command: "verdict" | "check";
  task?: string;
  taskFile?: string;
  diff?: string;
  diffFile?: string;
  verifyLogs?: string;
  verifyLogsFile?: string;
  builderReport?: string;
  builderReportFile?: string;
  base?: string;
  workspace: string;
  workspaceExplicit: boolean;
  verifyCommands: string[];
  verifyTimeoutMs?: number;
  configFile?: string;
  outputDir?: string;
  markdown: boolean;
  failOn?: FinalVerdictKind;
  pretty: boolean;
  help: boolean;
}

interface VerifierConfig {
  base?: string;
  intent?: string;
  intentFile?: string;
  verifyCommands?: string[];
  verifyTimeoutMs?: number;
  outputDir?: string;
  markdown?: boolean;
  failOn?: FinalVerdictKind;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const INFERRED_SCRIPT_ORDER = ["typecheck", "test", "build"] as const;
const execFileAsync = promisify(execFile);

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    const version = await readVersionInfo();
    process.stdout.write(argv.includes("--json")
      ? `${JSON.stringify(version)}\n`
      : `verifier ${version.version}\n`);
    return 0;
  }

  if (argv.length === 0 && process.env.KAIZEN_VERIFIER_RESULT_PATH) {
    const resultWriter = await prepareKaizenResult(
      process.env.KAIZEN_VERIFIER_RESULT_PATH
    );
    try {
      const artifacts = await prepareKaizenArtifacts(
        resultWriter.workspace,
        resultWriter.resultPath
      );
      const payload = await runKaizenLoopMode(resultWriter.write, {
        workspace: resultWriter.workspace,
        artifactsDir: artifacts.path,
        artifactsDirDev: artifacts.dev,
        artifactsDirIno: artifacts.ino
      });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    } finally {
      await resultWriter.close();
    }
  }

  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }

  if (options.command === "check" && await shouldRunWorkspaceCheck(options)) {
    const config = await readVerifierConfig(options.workspace, options.configFile);
    const configIntentFile = config.intentFile
      ? resolveWorkspacePath(options.workspace, config.intentFile)
      : undefined;
    const task = await readInlineOrFile(
      options.task ?? (options.taskFile ? undefined : config.intent),
      options.taskFile ?? (options.task ? undefined : configIntentFile)
    );
    const outputDir = options.outputDir ?? config.outputDir;
    const verifyTimeoutMs = options.verifyTimeoutMs ?? config.verifyTimeoutMs;
    const verifyCommands = await selectVerifyCommands(options, config);
    const base = options.base ?? config.base ?? await inferWorkspaceBase(options.workspace);
    const result = await runCheck({
      task,
      workspace: options.workspace,
      base,
      verifyCommands,
      ...(verifyTimeoutMs ? { verifyTimeoutMs } : {}),
      ...(outputDir ? { outputDir } : {})
    });
    const markdown = options.markdown || config.markdown === true;
    process.stdout.write(markdown
      ? `${result.markdown}\n`
      : `${JSON.stringify(result.verdict, null, options.pretty ? 2 : 0)}\n`);
    return shouldFailForVerdict(result.verdict.final_verdict!, options.failOn ?? config.failOn)
      ? 1
      : 0;
  }

  const input = VerdictInputSchema.parse({
    task: await readInlineOrFile(options.task, options.taskFile),
    diff: await readInlineOrFile(options.diff, options.diffFile),
    verifyLogs: await readInlineOrFile(
      options.verifyLogs,
      options.verifyLogsFile
    ),
    builderReport: await readInlineOrFile(
      options.builderReport,
      options.builderReportFile
    )
  });

  const verdict = evaluateMinimalVerdict(input);
  process.stdout.write(`${JSON.stringify(verdict, null, options.pretty ? 2 : 0)}\n`);
  return 0;
}

async function runKaizenLoopMode(
  writeResult: (content: string) => Promise<void>,
  context: {
    workspace: string;
    artifactsDir: string;
    artifactsDirDev: number | bigint;
    artifactsDirIno: number | bigint;
  }
): Promise<KaizenVerifierResult> {
  const startedAt = new Date();
  const prompt = await readStdin();
  const input = VerdictInputSchema.parse(parseKaizenLoopPrompt(prompt));
  const verification = parseKaizenVerificationCommands(input.verifyLogs);
  const verifyCommands = verification.commands;
  const verdict = evaluateMinimalVerdict({
    ...input,
    verifyLogs: [
      input.verifyLogs,
      ...verification.failedCommandNumbers.map(
        (number) => `Verification command failed: canonical record ${number}`
      )
    ].filter(Boolean).join("\n")
  });
  const evidenceGrade = verifyCommands.length > 0
    ? "executed"
    : verdict.evidence_grade ?? "reported";
  const reason =
    verdict.verdict === "block_pr"
      ? verdict.must_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary
      : verdict.verdict === "needs_context"
        ? verdict.should_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary
        : "";
  const completedAt = new Date();
  const payload = KaizenVerifierResultSchema.parse({
    schemaVersion: verdict.schemaVersion,
    verdict: verdict.verdict,
    final_verdict: finalVerdictForKaizen(verdict.verdict, input),
    status: verdict.verdict,
    evidence_grade: evidenceGrade,
    confidence: verdict.confidence,
    risk: verdict.risk,
    summary: verdict.summary,
    notes: [
      `evidence_grade=${evidenceGrade}`,
      `risk=${verdict.risk}`,
      `confidence=${verdict.confidence}`,
      verdict.must_fix.length ? `must_fix=${verdict.must_fix.map((item) => item.message).join("; ")}` : "",
      verdict.should_fix.length ? `should_fix=${verdict.should_fix.map((item) => item.message).join("; ")}` : ""
    ]
      .filter(Boolean)
      .join("\n"),
    reason,
    must_fix: verdict.must_fix,
    should_fix: verdict.should_fix,
    run: {
      id: `kaizen-${startedAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      workspace: context.workspace,
      base_ref: process.env.BASE_SHA ?? "unknown",
      head_ref: process.env.GITHUB_SHA ?? "unknown",
      artifacts_dir: context.artifactsDir,
      changed_files: changedFilesFromPrompt(prompt),
      verify_commands: verifyCommands
    }
  });
  const redactedPayload = redactSensitiveValue(payload);

  await persistKaizenArtifacts(context, input, redactedPayload);
  await writeResult(`${JSON.stringify(redactedPayload, null, 2)}\n`);
  return redactedPayload;
}

async function persistKaizenArtifacts(
  context: {
    workspace: string;
    artifactsDir: string;
    artifactsDirDev: number | bigint;
    artifactsDirIno: number | bigint;
  },
  input: VerdictInput,
  payload: KaizenVerifierResult
): Promise<void> {
  const redactedInput = redactSensitiveValue(input);
  const artifacts = [
    ["intent.txt", redactedInput.task],
    ["diff.patch", redactedInput.diff],
    ["verify-logs.txt", redactedInput.verifyLogs],
    ["builder-report.md", redactedInput.builderReport],
    ["report.md", renderKaizenReport(payload)],
    ["verdict.json", `${JSON.stringify(payload, null, 2)}\n`]
  ] as const;

  for (const [filename, content] of artifacts) {
    await writeKaizenArtifact(context, filename, content);
  }
}

function renderKaizenReport(payload: KaizenVerifierResult): string {
  const mustFix = payload.must_fix.length
    ? payload.must_fix
        .map((item) => `- ${item.message}${item.evidence ? ` Evidence: ${item.evidence}` : ""}`)
        .join("\n")
    : "- None";
  const shouldFix = payload.should_fix.length
    ? payload.should_fix
        .map((item) => `- ${item.message}${item.evidence ? ` Evidence: ${item.evidence}` : ""}`)
        .join("\n")
    : "- None";

  return [
    `# Verifier Verdict: ${payload.final_verdict}`,
    "",
    `Summary: ${payload.summary}`,
    "",
    `Compatibility verdict: ${payload.verdict}`,
    `Evidence grade: ${payload.evidence_grade}`,
    `Confidence: ${payload.confidence}`,
    `Risk: ${payload.risk}`,
    `Artifacts: ${payload.run.artifacts_dir}`,
    "",
    "## Must Fix",
    mustFix,
    "",
    "## Should Fix",
    shouldFix,
    ""
  ].join("\n");
}

async function writeKaizenArtifact(
  context: {
    workspace: string;
    artifactsDir: string;
    artifactsDirDev: number | bigint;
    artifactsDirIno: number | bigint;
  },
  filename: string,
  content: string
): Promise<void> {
  await assertKaizenArtifactDirectory(context);
  const artifactPath = join(context.artifactsDir, filename);
  let handle: FileHandle;
  try {
    handle = await open(
      artifactPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Kaizen artifact ${filename} resolves through a symbolic link.`);
    }
    throw error;
  }

  try {
    await assertKaizenArtifactDirectory(context);
    const [stat, pathStat] = await Promise.all([handle.stat(), lstat(artifactPath)]);
    if (
      pathStat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    ) {
      throw new Error(`Kaizen artifact ${filename} must be a regular, single-link file.`);
    }
    await handle.writeFile(redactSensitiveText(content), "utf8");
  } finally {
    await handle.close();
  }
}

async function assertKaizenArtifactDirectory(context: {
  workspace: string;
  artifactsDir: string;
  artifactsDirDev: number | bigint;
  artifactsDirIno: number | bigint;
}): Promise<void> {
  let pathStat: Awaited<ReturnType<typeof lstat>>;
  let canonicalPath: string;
  try {
    [pathStat, canonicalPath] = await Promise.all([
      lstat(context.artifactsDir),
      realpath(context.artifactsDir)
    ]);
  } catch {
    throw new Error("Kaizen artifact directory changed before it could be written safely.");
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    pathStat.dev !== context.artifactsDirDev ||
    pathStat.ino !== context.artifactsDirIno ||
    isPathOutside(context.workspace, canonicalPath)
  ) {
    throw new Error("Kaizen artifact directory changed before it could be written safely.");
  }
}

function finalVerdictForKaizen(
  verdict: VerdictDecision,
  input: VerdictInput
): FinalVerdictKind {
  if (verdict === "open_pr") return "mergeable";
  if (verdict === "open_pr_with_warning") return "conditional";
  if (verdict === "block_pr") return "not_mergeable";
  return input.diff.trim() ? "conditional" : "inconclusive";
}

function changedFilesFromPrompt(prompt: string): string[] {
  const files = lastSection(prompt, "# Changed files", ["# Diff", "# Decision rules"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s+/, "").trim())
    .map((path) => path.startsWith("`") && path.endsWith("`") ? path.slice(1, -1) : path)
    .filter(Boolean);
  return [...new Set(files)];
}

function lastSection(text: string, startMarker: string, endMarkers: string[]): string {
  const startMatches = [...text.matchAll(new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(startMarker)}[\\t ]*(?:\\r?\\n|$)`,
    "g"
  ))];
  const start = startMatches.at(-1);
  if (start?.index === undefined) return "";

  const body = text.slice(start.index + start[0].length);
  const endIndexes = endMarkers
    .map((endMarker) => new RegExp(
      `(?:^|\\r?\\n)${escapeRegExp(endMarker)}[\\t ]*(?:\\r?\\n|$)`
    ).exec(body)?.index)
    .filter((index): index is number => index !== undefined);
  if (endIndexes.length === 0) return "";
  return body.slice(0, Math.min(...endIndexes)).trim();
}

async function prepareKaizenResult(configuredPath: string): Promise<{
  write: (content: string) => Promise<void>;
  close: () => Promise<void>;
  workspace: string;
  resultPath: string;
}> {
  const configuredWorkspace = resolve(process.env.KAIZEN_WORKSPACE_DIR ?? process.cwd());
  const configuredResultPath = resolve(configuredWorkspace, configuredPath);
  if (isPathOutside(configuredWorkspace, configuredResultPath)) {
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH must stay within KAIZEN_WORKSPACE_DIR.");
  }

  if (configuredResultPath === configuredWorkspace) {
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH must name a file within KAIZEN_WORKSPACE_DIR.");
  }

  const workspace = await realpath(configuredWorkspace);
  const resultPath = resolve(
    workspace,
    relative(configuredWorkspace, configuredResultPath)
  );
  let ancestor = resultPath;
  while (!(await pathEntryExists(ancestor))) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const initialAncestor = await realpath(ancestor);
  if (isPathOutside(workspace, initialAncestor)) {
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH resolves outside KAIZEN_WORKSPACE_DIR.");
  }

  await mkdir(dirname(resultPath), { recursive: true });
  let resultHandle: FileHandle;
  try {
    resultHandle = await open(
      resultPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error("KAIZEN_VERIFIER_RESULT_PATH resolves through a symbolic link.");
    }
    if (code === "ENXIO") {
      throw new Error("KAIZEN_VERIFIER_RESULT_PATH must be a regular file.");
    }
    throw error;
  }
  const initialStat = await resultHandle.stat();
  if (!initialStat.isFile()) {
    await resultHandle.close();
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH must be a regular file.");
  }
  if (initialStat.nlink !== 1) {
    await resultHandle.close();
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH changed before it could be written safely.");
  }
  try {
    return {
      workspace,
      resultPath,
      write: async (content: string) => {
        const [realResult, openedStat, pathStat] = await Promise.all([
          realpath(resultPath),
          resultHandle.stat(),
          lstat(resultPath)
        ]);
        if (isPathOutside(workspace, realResult)) {
          throw new Error("KAIZEN_VERIFIER_RESULT_PATH resolves outside KAIZEN_WORKSPACE_DIR.");
        }
        if (
          !openedStat.isFile() ||
          openedStat.nlink !== 1 ||
          openedStat.dev !== pathStat.dev ||
          openedStat.ino !== pathStat.ino
        ) {
          throw new Error("KAIZEN_VERIFIER_RESULT_PATH changed before it could be written safely.");
        }
        await resultHandle.truncate(0);
        await resultHandle.writeFile(content, "utf8");
      },
      close: () => resultHandle.close()
    };
  } catch (error) {
    await resultHandle.close();
    throw error;
  }
}

async function prepareKaizenArtifacts(workspace: string, resultPath: string): Promise<{
  path: string;
  dev: number | bigint;
  ino: number | bigint;
}> {
  const resultDir = dirname(resultPath);
  const verifiedResultDir = await realpath(resultDir);
  if (isPathOutside(workspace, verifiedResultDir)) {
    throw new Error("Kaizen artifact directory resolves outside KAIZEN_WORKSPACE_DIR.");
  }

  const artifactsDir = await mkdtemp(join(resultDir, ".verifier-artifacts-"));
  try {
    const [canonicalArtifactsDir, artifactsStat] = await Promise.all([
      realpath(artifactsDir),
      lstat(artifactsDir)
    ]);
    if (
      isPathOutside(workspace, canonicalArtifactsDir) ||
      dirname(canonicalArtifactsDir) !== verifiedResultDir
    ) {
      throw new Error("Kaizen artifact directory changed before it could be written safely.");
    }
    return {
      path: canonicalArtifactsDir,
      dev: artifactsStat.dev,
      ino: artifactsStat.ino
    };
  } catch (error) {
    await rm(artifactsDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function isPathOutside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseKaizenLoopPrompt(prompt: string) {
  return {
    task: section(prompt, "# Issue", "# Builder result") || prompt,
    builderReport: section(prompt, "# Builder result", "# Mechanical verification"),
    verifyLogs: section(prompt, "# Mechanical verification", "# Changed files"),
    diff: sectionAfter(prompt, "# Changed files", "# Diff", "# Decision rules")
  };
}

function parseKaizenVerificationCommands(verifyLogs: string): {
  commands: VerdictRun["verify_commands"];
  failedCommandNumbers: number[];
} {
  const invalid = { commands: [], failedCommandNumbers: [] };
  const taggedBlocks = [...verifyLogs.matchAll(
    /^<verification_logs_data>\r?\n([\s\S]*?)\r?\n<\/verification_logs_data>$/gm
  )];
  const taggedBlock = taggedBlocks.at(-1)?.[1];
  if (!taggedBlock) return invalid;

  const outerFence = /^(`{3,})markdown\r?\n([\s\S]*)\r?\n\1$/.exec(taggedBlock);
  if (!outerFence) return invalid;

  const openingFence = outerFence[1];
  const records = outerFence[2];
  if (!openingFence || records === undefined) return invalid;
  const prematureClosingFence = new RegExp(
    `^ {0,3}\`{${openingFence.length},}[\\t ]*$`,
    "m"
  );
  if (prematureClosingFence.test(records)) return invalid;

  const recordPattern = /^## Command (\d+)\r?\n\r?\nStatus: (passed|failed)\r?\n\r?\nCommand:\r?\n(`{3,})sh\r?\n([\s\S]*?)\r?\n\3\r?\n\r?\nOutput:\r?\n(`{3,})text\r?\n([\s\S]*?)\r?\n\5(?=\r?\n\r?\n## Command \d+\r?\n|$)/gm;
  const commands: VerdictRun["verify_commands"] = [];
  const failedCommandNumbers: number[] = [];
  let previousEnd = 0;

  for (const match of records.matchAll(recordPattern)) {
    if (records.slice(previousEnd, match.index).trim()) return invalid;
    const commandNumber = Number(match[1]);
    if (commandNumber !== commands.length + 1 || !match[4]) return invalid;
    commands.push({
      command: match[4],
      exit_code: match[2] === "passed" ? 0 : null,
      signal: null,
      duration_ms: 0
    });
    if (match[2] === "failed") failedCommandNumbers.push(commandNumber);
    previousEnd = (match.index ?? 0) + match[0].length;
  }

  return commands.length > 0 && !records.slice(previousEnd).trim()
    ? { commands, failedCommandNumbers }
    : invalid;
}

function sectionAfter(text: string, anchorMarker: string, startMarker: string, endMarker: string): string {
  const anchor = new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(anchorMarker)}[\\t ]*(?:\\r?\\n|$)`
  ).exec(text);
  if (!anchor) return "";
  return section(text.slice(anchor.index + anchor[0].length), startMarker, endMarker);
}

function section(text: string, startMarker: string, endMarker: string): string {
  const start = new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(startMarker)}[\\t ]*(?:\\r?\\n|$)`
  ).exec(text);
  if (!start) return "";
  const bodyStart = start.index + start[0].length;
  const body = text.slice(bodyStart);
  const end = new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(endMarker)}[\\t ]*(?:\\r?\\n|$)`
  ).exec(body);
  return body.slice(0, end?.index).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] === "check" || argv[0] === "verdict" ? argv[0] : "verdict";
  const options: CliOptions = {
    command,
    workspace: process.cwd(),
    workspaceExplicit: false,
    verifyCommands: [],
    markdown: false,
    pretty: false,
    help: false
  };
  const args = argv[0] === "check" || argv[0] === "verdict" ? argv.slice(1) : argv;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--pr":
      case "--stages":
      case "--reuse-claims":
        throw new Error(
          `${arg} is part of the staged verifier spec but is not supported by this MVP. ` +
            "Use --task/--task-file and --diff/--diff-file inputs, or workspace check inputs."
        );
      case "--json":
        break;
      case "--task":
      case "--intent":
        options.task = readFlagValue(args, ++index, arg);
        break;
      case "--task-file":
      case "--intent-file":
        options.taskFile = readFlagValue(args, ++index, arg);
        break;
      case "--diff":
        options.diff = readFlagValue(args, ++index, arg);
        break;
      case "--diff-file":
        options.diffFile = readFlagValue(args, ++index, arg);
        break;
      case "--verify-logs":
        options.verifyLogs = readFlagValue(args, ++index, arg);
        break;
      case "--verify-logs-file":
        options.verifyLogsFile = readFlagValue(args, ++index, arg);
        break;
      case "--builder-report":
        options.builderReport = readFlagValue(args, ++index, arg);
        break;
      case "--builder-report-file":
        options.builderReportFile = readFlagValue(args, ++index, arg);
        break;
      case "--base":
        options.base = readFlagValue(args, ++index, arg);
        break;
      case "--workspace":
        options.workspace = readFlagValue(args, ++index, arg);
        options.workspaceExplicit = true;
        break;
      case "--verify-command":
        options.verifyCommands.push(readFlagValue(args, ++index, arg));
        break;
      case "--verify-timeout-ms":
        options.verifyTimeoutMs = parsePositiveInteger(readFlagValue(args, ++index, arg), arg);
        break;
      case "--config":
        options.configFile = readFlagValue(args, ++index, arg);
        break;
      case "--output-dir":
        options.outputDir = readFlagValue(args, ++index, arg);
        break;
      case "--markdown":
        options.markdown = true;
        break;
      case "--fail-on":
        options.failOn = parseFinalVerdictKind(readFlagValue(args, ++index, arg));
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }

  return options;
}

async function shouldRunWorkspaceCheck(options: CliOptions): Promise<boolean> {
  if (options.command !== "check") return false;
  if (
    options.base !== undefined ||
    options.workspaceExplicit ||
    options.verifyCommands.length > 0 ||
    options.verifyTimeoutMs !== undefined ||
    options.configFile !== undefined ||
    options.outputDir !== undefined ||
    options.markdown ||
    options.failOn !== undefined
  ) {
    return true;
  }

  const hasDirectVerdictInput =
    options.diff !== undefined ||
    options.diffFile !== undefined ||
    options.verifyLogs !== undefined ||
    options.verifyLogsFile !== undefined ||
    options.builderReport !== undefined ||
    options.builderReportFile !== undefined;
  if (hasDirectVerdictInput) return false;

  const configPath = join(options.workspace, "verifier.config.json");
  if (!(await fileExists(configPath))) return false;
  const config = await readVerifierConfig(options.workspace, undefined);
  return Boolean(
    config.base ||
      config.intent ||
      config.intentFile ||
      config.verifyCommands ||
      config.verifyTimeoutMs ||
      config.outputDir ||
      config.markdown ||
      config.failOn
  );
}

async function selectVerifyCommands(
  options: CliOptions,
  config: VerifierConfig
): Promise<string[]> {
  if (options.verifyCommands.length > 0) return options.verifyCommands;
  if (config.verifyCommands !== undefined) return config.verifyCommands;
  return inferWorkspaceVerifyCommands(options.workspace);
}

async function inferWorkspaceVerifyCommands(workspace: string): Promise<string[]> {
  const packageJsonPath = join(workspace, "package.json");
  if (!(await fileExists(packageJsonPath))) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];

  const scripts = parsed.scripts;
  const packageManager = await inferPackageManager(workspace, parsed.packageManager);
  return INFERRED_SCRIPT_ORDER
    .filter((scriptName) => {
      const script = scripts[scriptName];
      return typeof script === "string" && script.trim().length > 0;
    })
    .map((scriptName) => packageScriptCommand(packageManager, scriptName));
}

async function inferWorkspaceBase(workspace: string): Promise<string> {
  const originHead = await readGitOutput(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    workspace
  );
  const candidates = originHead
    ? [originHead, "origin/main", "origin/master", "main", "master"]
    : ["origin/main", "origin/master", "main", "master"];
  for (const candidate of candidates) {
    if (!(await gitCommitExists(candidate, workspace))) continue;
    const mergeBase = await readGitOutput(["merge-base", "HEAD", candidate], workspace);
    if (mergeBase) return mergeBase;
  }

  const rootCommit = await readGitOutput(
    ["rev-list", "--first-parent", "--max-parents=0", "HEAD"],
    workspace
  );
  return rootCommit || "HEAD";
}

async function gitCommitExists(ref: string, workspace: string): Promise<boolean> {
  return Boolean(await readGitOutput(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    workspace
  ));
}

async function readGitOutput(args: string[], workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspace,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function inferPackageManager(
  workspace: string,
  packageManagerMetadata: unknown
): Promise<PackageManager> {
  if (typeof packageManagerMetadata === "string") {
    if (packageManagerMetadata.startsWith("pnpm@")) return "pnpm";
    if (packageManagerMetadata.startsWith("yarn@")) return "yarn";
    if (packageManagerMetadata.startsWith("bun@")) return "bun";
    if (packageManagerMetadata.startsWith("npm@")) return "npm";
  }

  if (await fileExists(join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(workspace, "yarn.lock"))) return "yarn";
  if (await fileExists(join(workspace, "bun.lockb")) || await fileExists(join(workspace, "bun.lock"))) return "bun";
  return "npm";
}

function packageScriptCommand(packageManager: PackageManager, scriptName: string): string {
  if (packageManager === "pnpm") return `pnpm ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function readInlineOrFile(
  inlineValue: string | undefined,
  filePath: string | undefined
): Promise<string> {
  if (inlineValue !== undefined && filePath !== undefined) {
    throw new Error("Use either inline value or file value for each input, not both.");
  }
  if (inlineValue !== undefined) return inlineValue;
  if (filePath !== undefined) return readFile(filePath, "utf8");
  return "";
}

async function readVerifierConfig(
  workspace: string,
  configFile: string | undefined
): Promise<VerifierConfig> {
  const configPath = configFile ?? join(workspace, "verifier.config.json");
  if (!configFile && !(await fileExists(configPath))) return {};
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("verifier.config.json must contain a JSON object.");
  }

  const config: VerifierConfig = {};
  const base = readOptionalConfigString(parsed, "base");
  const intent = readOptionalConfigString(parsed, "intent");
  const intentFile = readOptionalConfigString(parsed, "intentFile");
  const outputDir = readOptionalConfigString(parsed, "outputDir");
  if (base !== undefined) config.base = base;
  if (intent !== undefined) config.intent = intent;
  if (intentFile !== undefined) config.intentFile = intentFile;
  if (outputDir !== undefined) config.outputDir = outputDir;

  if (parsed.verifyCommands !== undefined) {
    if (!Array.isArray(parsed.verifyCommands)) {
      throw new Error("verifier.config.json verifyCommands must be an array.");
    }
    config.verifyCommands = parsed.verifyCommands.map((command, index) => {
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error(`verifier.config.json verifyCommands[${index}] must be a non-empty string.`);
      }
      return command;
    });
  }
  if (parsed.verifyTimeoutMs !== undefined) {
    if (
      typeof parsed.verifyTimeoutMs !== "number" ||
      !Number.isInteger(parsed.verifyTimeoutMs) ||
      parsed.verifyTimeoutMs <= 0
    ) {
      throw new Error("verifier.config.json verifyTimeoutMs must be a positive integer.");
    }
    config.verifyTimeoutMs = parsed.verifyTimeoutMs;
  }
  if (parsed.markdown !== undefined) {
    if (typeof parsed.markdown !== "boolean") {
      throw new Error("verifier.config.json markdown must be a boolean.");
    }
    config.markdown = parsed.markdown;
  }
  if (parsed.failOn !== undefined) {
    if (typeof parsed.failOn !== "string") {
      throw new Error("verifier.config.json failOn must be a string.");
    }
    config.failOn = parseFinalVerdictKind(parsed.failOn);
  }
  return config;
}

function readOptionalConfigString(
  config: Record<string, unknown>,
  field: "base" | "intent" | "intentFile" | "outputDir"
): string | undefined {
  const value = config[field];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`verifier.config.json ${field} must be a string.`);
  }
  return value;
}

function resolveWorkspacePath(workspace: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspace, path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseFinalVerdictKind(value: string): FinalVerdictKind {
  if (
    value === "mergeable" ||
    value === "conditional" ||
    value === "not_mergeable" ||
    value === "inconclusive"
  ) {
    return value;
  }
  throw new Error(`Unknown final verdict kind: ${value}`);
}

function helpText(): string {
  return `Usage:
  verifier check [options]
  verifier verdict [options]
  verifier [options]

Options:
  --task <text>                    Task or intent text
  --intent <text>                  Alias for --task
  --task-file <path>               File containing task or intent text
  --intent-file <path>             Alias for --task-file
  --diff <text>                    Diff text for direct contract checks
  --diff-file <path>               File containing diff text
  --verify-logs <text>             Verification log text for direct contract checks
  --verify-logs-file <path>        File containing verification logs
  --builder-report <text>          Builder report text
  --builder-report-file <path>     File containing builder report
  --base <ref>                     Base ref for workspace check diff (default: inferred)
  --workspace <path>               Repository path for workspace check (default: cwd)
  --config <path>                  JSON config file (default: verifier.config.json)
  --verify-command <cmd>           Command to run during workspace check; repeatable
  --verify-timeout-ms <ms>         Timeout for each workspace verify command (default: 600000)
  --output-dir <path>              Directory for workspace check artifacts
  --markdown                       Print the Markdown workspace check report to stdout
  --fail-on <kind>                 Exit 1 when workspace check reaches kind or stricter
  --json                           Accepted for spec compatibility; JSON is always written to stdout
  --pretty                         Pretty-print JSON
  -h, --help                       Show this help

Future staged verifier flags such as --pr, --stages, and --reuse-claims are
documented in the public spec but are not supported by this MVP command yet.
`;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verifier: ${message}\n`);
    process.exitCode = 2;
  }
);
