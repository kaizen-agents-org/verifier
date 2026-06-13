#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { evaluateMinimalVerdict, VerdictInputSchema } from "./index.js";

interface CliOptions {
  task?: string;
  taskFile?: string;
  diff?: string;
  diffFile?: string;
  verifyLogs?: string;
  verifyLogsFile?: string;
  builderReport?: string;
  builderReportFile?: string;
  pretty: boolean;
  help: boolean;
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
  reason?: string;
}> {
  const prompt = await readStdin();
  const input = VerdictInputSchema.parse(parseKaizenLoopPrompt(prompt));
  const verdict = evaluateMinimalVerdict(input);
  const payload = {
    status: verdict.verdict,
    summary: verdict.summary,
    notes: [
      `risk=${verdict.risk}`,
      `confidence=${verdict.confidence}`,
      verdict.must_fix.length ? `must_fix=${verdict.must_fix.map((item) => item.message).join("; ")}` : "",
      verdict.should_fix.length ? `should_fix=${verdict.should_fix.map((item) => item.message).join("; ")}` : ""
    ]
      .filter(Boolean)
      .join("\n"),
    ...(verdict.verdict === "block_pr"
      ? { reason: verdict.must_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary }
      : verdict.verdict === "needs_context"
        ? { reason: verdict.should_fix.map((item) => item.evidence || item.message).join("\n") || verdict.summary }
        : {})
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
  const options: CliOptions = { pretty: false, help: false };
  const args = argv[0] === "verdict" ? argv.slice(1) : argv;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--task":
        options.task = readFlagValue(args, ++index, arg);
        break;
      case "--task-file":
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

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
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

function helpText(): string {
  return `Usage:
  verifier verdict [options]
  verifier [options]

Options:
  --task <text>                    Task or intent text
  --task-file <path>               File containing task or intent text
  --diff <text>                    Diff text
  --diff-file <path>               File containing diff text
  --verify-logs <text>             Verification log text
  --verify-logs-file <path>        File containing verification logs
  --builder-report <text>          Builder report text
  --builder-report-file <path>     File containing builder report
  --pretty                         Pretty-print JSON
  -h, --help                       Show this help
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
