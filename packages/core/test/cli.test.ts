import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI", () => {
  it("supports check with inline task and diff inputs", async () => {
    const { stdout, stderr } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--task",
        "Add signup validation",
        "--diff",
        "diff --git a/signup.ts b/signup.ts\n+validateEmail(input.email)",
        "--verify-logs",
        "pnpm test passed",
        "--builder-report",
        "Implemented validation and tests."
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { verdict: string; summary: string };

    expect(stderr).toBe("");
    expect(output.verdict).toBe("open_pr");
    expect(output.summary).toContain("Open PR");
  });

  it("supports check with file task and diff inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const taskPath = join(dir, "task.md");
    const diffPath = join(dir, "diff.patch");
    await writeFile(taskPath, "Add signup validation", "utf8");
    await writeFile(
      diffPath,
      "diff --git a/signup.ts b/signup.ts\n+validateEmail(input.email)",
      "utf8"
    );

    const { stdout } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--task-file",
        taskPath,
        "--diff-file",
        diffPath,
        "--verify-logs",
        "pnpm test passed",
        "--builder-report",
        "Implemented validation and tests."
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { verdict: string };

    expect(output.verdict).toBe("open_pr");
  });

  it.each([
    ["verdict command", ["verdict"]],
    ["bare options", []]
  ])("keeps %s compatibility", async (_name, commandArgs) => {
    const { stdout } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        ...commandArgs,
        "--task",
        "Add signup validation",
        "--diff",
        "diff --git a/signup.ts b/signup.ts\n+validateEmail(input.email)",
        "--verify-logs",
        "pnpm test passed",
        "--builder-report",
        "Implemented validation and tests."
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { verdict: string };

    expect(output.verdict).toBe("open_pr");
  });

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

Return "block_pr" when the builder must revise the change before a PR is created.
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

    const output = JSON.parse(stdout) as { status: string; summary: string; reason: string };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      summary: string;
      reason: string;
    };

    expect(output.status).toBe("open_pr");
    expect(result.status).toBe("open_pr");
    expect(result.summary).toContain("Open PR");
    expect(output.reason).toBe("");
    expect(result.reason).toBe("");
  });
});

function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options: { env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command exited with ${code}: ${stderr}${stdout}`));
      }
    });
    child.stdin.end(input);
  });
}
