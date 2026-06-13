#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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

