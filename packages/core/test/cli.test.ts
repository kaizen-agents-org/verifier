import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

    const output = JSON.parse(stdout) as { status: string; summary: string };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      summary: string;
    };

    expect(output.status).toBe("open_pr");
    expect(result.status).toBe("open_pr");
    expect(result.summary).toContain("Open PR");
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
