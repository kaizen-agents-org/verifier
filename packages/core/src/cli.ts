#!/usr/bin/env node
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCheck, shouldFailForVerdict } from "./check.js";
import { evaluateMinimalVerdict } from "./minimal-verdict.js";
import { redactSensitiveValue } from "./redaction.js";
import { VerdictInputSchema } from "./types.js";
import type {
  FinalVerdictKind,
  KaizenVerifierResult,
  VerdictDecision,
  VerdictInput
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
      const payload = await runKaizenLoopMode(resultWriter.write, {
        workspace: resultWriter.workspace,
        artifactsDir: dirname(resultWriter.resultPath)
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
    const result = await runCheck({
      task,
      workspace: options.workspace,
      base: options.base ?? config.base ?? "HEAD",
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
  context: { workspace: string; artifactsDir: string }
): Promise<KaizenVerifierResult> {
  const startedAt = new Date();
  const prompt = await readStdin();
  const input = VerdictInputSchema.parse(parseKaizenLoopPrompt(prompt));
  const verdict = evaluateMinimalVerdict(input);
  const reason =
    verdict.verdict === "block_pr"
      ? verdict.must_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary
      : verdict.verdict === "needs_context"
        ? verdict.should_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary
        : "";
  const completedAt = new Date();
  const payload: KaizenVerifierResult = {
    schemaVersion: verdict.schemaVersion,
    verdict: verdict.verdict,
    final_verdict: finalVerdictForKaizen(verdict.verdict, input),
    status: verdict.verdict,
    evidence_grade: verdict.evidence_grade ?? "reported",
    confidence: verdict.confidence,
    risk: verdict.risk,
    summary: verdict.summary,
    notes: [
      verdict.evidence_grade ? `evidence_grade=${verdict.evidence_grade}` : "",
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
      verify_commands: []
    }
  };
  const redactedPayload = redactSensitiveValue(payload);

  await writeResult(`${JSON.stringify(redactedPayload, null, 2)}\n`);
  return redactedPayload;
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
  const files = lastSection(prompt, "# Changed files", "# Diff")
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s+/, "").trim())
    .map((path) => path.startsWith("`") && path.endsWith("`") ? path.slice(1, -1) : path)
    .filter(Boolean);
  return [...new Set(files)];
}

function lastSection(text: string, startMarker: string, endMarker: string): string {
  const endMatches = [...text.matchAll(new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(endMarker)}[\\t ]*(?:\\r?\\n|$)`,
    "g"
  ))];
  const end = endMatches.at(-1);
  if (end?.index === undefined) return "";

  const beforeEnd = text.slice(0, end.index);
  const startMatches = [...beforeEnd.matchAll(new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(startMarker)}[\\t ]*(?:\\r?\\n|$)`,
    "g"
  ))];
  const start = startMatches.at(-1);
  if (start?.index === undefined) return "";
  return text.slice(start.index + start[0].length, end.index).trim();
}

async function prepareKaizenResult(configuredPath: string): Promise<{
  write: (content: string) => Promise<void>;
  close: () => Promise<void>;
  workspace: string;
  resultPath: string;
}> {
  const workspace = resolve(process.env.KAIZEN_WORKSPACE_DIR ?? process.cwd());
  const resultPath = resolve(workspace, configuredPath);
  if (isPathOutside(workspace, resultPath)) {
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH must stay within KAIZEN_WORKSPACE_DIR.");
  }

  if (resultPath === workspace) {
    throw new Error("KAIZEN_VERIFIER_RESULT_PATH must name a file within KAIZEN_WORKSPACE_DIR.");
  }

  let ancestor = resultPath;
  while (!(await pathEntryExists(ancestor))) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const [initialWorkspace, initialAncestor] = await Promise.all([
    realpath(workspace),
    realpath(ancestor)
  ]);
  if (isPathOutside(initialWorkspace, initialAncestor)) {
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
    const realWorkspace = await realpath(workspace);
    return {
      workspace: realWorkspace,
      resultPath,
      write: async (content: string) => {
        const [realResult, openedStat, pathStat] = await Promise.all([
          realpath(resultPath),
          resultHandle.stat(),
          lstat(resultPath)
        ]);
        if (isPathOutside(realWorkspace, realResult)) {
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
  --base <ref>                     Base ref for workspace check diff (default: HEAD)
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
