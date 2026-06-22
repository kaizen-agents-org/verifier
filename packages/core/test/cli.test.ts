import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI", () => {
  it("supports the kaizen-loop stdin/result-file contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `You are the verifier for the kaizen-loop run in "repo".

# Issue #1: Add signup validation

Validate email addresses.

# Builder result

Implemented validation and tests.

# Mechanical verification

- [x] pnpm test
- [x] pnpm typecheck

# Changed files

- src/signup.ts
- test/signup.test.ts

# Decision rules

Return "rejected" when the builder must revise the change before a PR is created.
`;

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as { status: string; summary: string };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      summary: string;
    };

    expect(output.status).toBe("approved");
    expect(result.status).toBe("approved");
    expect(result.summary).toContain("Approved");
  });

  it("checks a workspace by collecting git diff and running verification commands", async () => {
    const dir = await createChangedRepo();
    const taskPath = join(dir, "task.md");
    await writeFile(taskPath, "Update greeting text.\n", "utf8");

    const { stdout } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir,
        "--task-file",
        taskPath,
        "--verify-command",
        "node -e \"console.log('all tests passed')\""
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      verdict: string;
      final_verdict: string;
      risk: string;
      run: { artifacts_dir: string; changed_files: string[] };
      evidence: Array<{ path: string }>;
    };

    expect(output.verdict).toBe("approved");
    expect(output.final_verdict).toBe("mergeable");
    expect(output.risk).toBe("low");
    expect(output.run.changed_files).toEqual(["greeting.txt"]);
    expect(output.evidence.map((item) => item.path)).toContain("verdict.json");
    await expect(readFile(join(output.run.artifacts_dir, "verdict.json"), "utf8")).resolves.toContain("mergeable");
    await expect(readFile(join(output.run.artifacts_dir, "report.md"), "utf8")).resolves.toContain("# Verifier Verdict: mergeable");
  });

  it("rejects check results when a verification command fails", async () => {
    const dir = await createChangedRepo();

    const { stdout } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir,
        "--task",
        "Update greeting text.",
        "--verify-command",
        "node -e \"process.exit(1)\""
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      verdict: string;
      final_verdict: string;
      must_fix: Array<{ evidence?: string }>;
    };

    expect(output.verdict).toBe("rejected");
    expect(output.final_verdict).toBe("not_mergeable");
    expect(output.must_fix.some((item) => item.evidence?.includes("exit code 1"))).toBe(true);
  });

  it("prints markdown reports for check", async () => {
    const dir = await createChangedRepo();

    const { stdout } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir,
        "--intent",
        "Update greeting text.",
        "--verify-command",
        "node -e \"console.log('all tests passed')\"",
        "--markdown"
      ],
      "",
      { env: process.env }
    );

    expect(stdout).toContain("# Verifier Verdict: mergeable");
    expect(stdout).toContain("## Verification Commands");
  });

  it("loads verifier.config.json and fails CI gates with --fail-on", async () => {
    const dir = await createChangedRepo();
    await writeFile(
      join(dir, "verifier.config.json"),
      JSON.stringify({
        intent: "Update greeting text.",
        verifyCommands: []
      }),
      "utf8"
    );

    const { stdout, code } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir,
        "--fail-on",
        "conditional"
      ],
      "",
      { env: process.env, allowFailure: true }
    );
    const output = JSON.parse(stdout) as { final_verdict: string; conditions: string[] };

    expect(code).toBe(1);
    expect(output.final_verdict).toBe("conditional");
    expect(output.conditions).toContain("Run at least one verification command.");
  });
});

function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options: { env: NodeJS.ProcessEnv; allowFailure?: boolean }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"]
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
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command exited with ${code}: ${stderr}${stdout}`));
      }
    });
    child.stdin.end(input);
  });
}

async function createChangedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "verifier-check-"));
  await writeFile(join(dir, "greeting.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["add", "greeting.txt"], { cwd: dir });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Verifier",
      "-c",
      "user.email=verifier@example.test",
      "commit",
      "-m",
      "initial"
    ],
    { cwd: dir }
  );
  await writeFile(join(dir, "greeting.txt"), "hello verifier\n", "utf8");
  return dir;
}
