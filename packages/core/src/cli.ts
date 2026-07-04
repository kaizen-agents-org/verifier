#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runCheck, shouldFailForVerdict } from "./check.js";
import { evaluateMinimalVerdict, VerdictInputSchema } from "./index.js";
import type { FinalVerdictKind } from "./types.js";

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

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write("verifier 0.0.0\n");
    return 0;
  }

  if (argv.length === 0 && process.env.KAIZEN_VERIFIER_RESULT_PATH) {
    const payload = await runKaizenLoopMode();
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
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
    const result = await runCheck({
      task,
      workspace: options.workspace,
      base: options.base ?? config.base ?? "HEAD",
      verifyCommands: options.verifyCommands.length > 0
        ? options.verifyCommands
        : config.verifyCommands ?? [],
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

async function runKaizenLoopMode(): Promise<{
  status: "open_pr" | "open_pr_with_warning" | "block_pr" | "needs_context";
  summary: string;
  notes: string;
  reason: string;
}> {
  const prompt = await readStdin();
  const input = VerdictInputSchema.parse(parseKaizenLoopPrompt(prompt));
  const verdict = evaluateMinimalVerdict(input);
  const reason =
    verdict.verdict === "block_pr"
      ? verdict.must_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary
      : verdict.verdict === "needs_context"
        ? verdict.should_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary
        : "";
  const payload = {
    status: verdict.verdict,
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
    reason
  };

  await writeFile(process.env.KAIZEN_VERIFIER_RESULT_PATH!, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function parseKaizenLoopPrompt(prompt: string) {
  return {
    task: section(prompt, "# Issue", "# Builder result") || prompt,
    builderReport: section(prompt, "# Builder result", "# Mechanical verification"),
    verifyLogs: section(prompt, "# Mechanical verification", "# Changed files"),
    diff: section(prompt, "# Changed files", "# Decision rules")
  };
}

function section(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const bodyStart = text.indexOf("\n", start);
  if (bodyStart === -1) return "";
  const end = text.indexOf(endMarker, bodyStart + 1);
  return text.slice(bodyStart + 1, end === -1 ? undefined : end).trim();
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
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as VerifierConfig;
  if (parsed.failOn !== undefined) parsed.failOn = parseFinalVerdictKind(parsed.failOn);
  if (parsed.verifyCommands !== undefined && !Array.isArray(parsed.verifyCommands)) {
    throw new Error("verifier.config.json verifyCommands must be an array.");
  }
  if (parsed.verifyTimeoutMs !== undefined) {
    parsed.verifyTimeoutMs = parsePositiveInteger(String(parsed.verifyTimeoutMs), "verifier.config.json verifyTimeoutMs");
  }
  return parsed;
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
