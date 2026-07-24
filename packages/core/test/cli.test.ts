import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function nodeEvalCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

describe("CLI", { timeout: 20_000 }, () => {
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

    const output = JSON.parse(stdout) as {
      verdict: string;
      summary: string;
      evidence_grade?: string;
    };

    expect(stderr).toBe("");
    expect(output.verdict).toBe("open_pr");
    expect(output.evidence_grade).toBe("reported");
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

# Diff

diff --git a/src/signup.ts b/src/signup.ts
+validateEmail(input.email)

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
      notes: string;
      reason: string;
    };

    expect(output.status).toBe("open_pr");
    expect(result.status).toBe("open_pr");
    expect(result.summary).toContain("Open PR");
    expect(result.notes).toContain("evidence_grade=reported");
    expect(output.reason).toBe("");
    expect(result.reason).toBe("");
  });

  it("needs context for kaizen-loop prompts with only a changed-file inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `# Issue

Add signup validation.

# Builder result

Implemented validation and tests.

# Mechanical verification

- [x] pnpm test

# Changed files

- src/signup.ts
- test/signup.test.ts

# Decision rules

Return a verdict.
`;

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: resultPath
        }
      }
    );

    const output = JSON.parse(stdout) as { status: string; reason: string };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      reason: string;
    };

    expect(output.status).toBe("needs_context");
    expect(result.status).toBe("needs_context");
    expect(output.reason).toContain("Diff is missing");
    expect(result.reason).toContain("Diff is missing");
  });

  it("blocks high-risk kaizen-loop prompts without targeted verification evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `You are the verifier for the kaizen-loop run in "repo".

# Issue #2: Preserve billing token handling

Keep payment token handling covered by focused verification.

# Builder result

Changed billing token extraction and ran generic project checks.

# Mechanical verification

- [x] pnpm test
- [x] pnpm typecheck

# Changed files

- src/billing.ts

# Diff

diff --git a/src/billing.ts b/src/billing.ts
+const token = req.body.token

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

    const output = JSON.parse(stdout) as { status: string; reason: string };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      notes: string;
      reason: string;
    };

    expect(output.status).toBe("block_pr");
    expect(result.status).toBe("block_pr");
    expect(output.reason).toContain("focused verification");
    expect(result.reason).toContain("focused verification");
    expect(result.notes).toContain("Diff touches high-risk billing/payments code");
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
        nodeEvalCommand("console.log('all tests passed')")
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      verdict: string;
      evidence_grade?: string;
      final_verdict: string;
      risk: string;
      run: { artifacts_dir: string; changed_files: string[] };
      evidence: Array<{ path: string }>;
    };

    expect(output.verdict).toBe("open_pr");
    expect(output.evidence_grade).toBe("executed");
    expect(output.final_verdict).toBe("mergeable");
    expect(output.risk).toBe("low");
    expect(output.run.changed_files).toEqual(["greeting.txt"]);
    expect(output.evidence.map((item) => item.path)).toContain("verdict.json");
    await expect(readFile(join(output.run.artifacts_dir, "verdict.json"), "utf8")).resolves.toContain("mergeable");
    await expect(readFile(join(output.run.artifacts_dir, "report.md"), "utf8")).resolves.toContain("# Verifier Verdict: mergeable");
    await expect(readFile(join(output.run.artifacts_dir, "report.md"), "utf8")).resolves.toContain("Evidence grade: executed");
  });

  it("infers package.json verification scripts when commands are omitted", async () => {
    const dir = await createChangedRepo();
    await writePackageManifest(dir, {
      packageManager: "pnpm@10.26.0",
      scripts: {
        build: "node -e \"console.log('build passed')\"",
        test: "node -e \"console.log('test passed')\"",
        typecheck: "node -e \"console.log('typecheck passed')\""
      }
    });

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
        "Update greeting text."
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      evidence_grade?: string;
      final_verdict: string;
      run: {
        artifacts_dir: string;
        verify_commands: Array<{ command: string; exit_code: number | null }>;
      };
    };

    expect(output.evidence_grade).toBe("executed");
    expect(output.final_verdict).toBe("mergeable");
    expect(output.run.verify_commands).toEqual([
      expect.objectContaining({ command: "pnpm typecheck", exit_code: 0 }),
      expect.objectContaining({ command: "pnpm test", exit_code: 0 }),
      expect.objectContaining({ command: "pnpm build", exit_code: 0 })
    ]);

    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");
    const verdictArtifact = await readFile(join(output.run.artifacts_dir, "verdict.json"), "utf8");
    expect(logsArtifact).toContain("$ pnpm typecheck");
    expect(logsArtifact).toContain("typecheck passed");
    expect(verdictArtifact).toContain("\"command\": \"pnpm typecheck\"");
  });

  it("uses explicit CLI verification commands instead of inferred package.json scripts", async () => {
    const dir = await createChangedRepo();
    await writePackageManifest(dir, {
      packageManager: "pnpm@10.26.0",
      scripts: {
        test: "node -e \"console.log('manifest test passed')\"",
        typecheck: "node -e \"console.log('manifest typecheck passed')\""
      }
    });
    const explicitCommand = nodeEvalCommand("console.log('explicit passed')");

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
        explicitCommand
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      run: {
        artifacts_dir: string;
        verify_commands: Array<{ command: string }>;
      };
    };

    expect(output.run.verify_commands.map((command) => command.command)).toEqual([explicitCommand]);
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");
    expect(logsArtifact).toContain("explicit passed");
    expect(logsArtifact).not.toContain("manifest test passed");
  });

  it("treats silent successful verification commands as positive evidence", async () => {
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
        nodeEvalCommand("process.exit(0)")
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      verdict: string;
      final_verdict: string;
      conditions: string[];
    };

    expect(output.verdict).toBe("open_pr");
    expect(output.final_verdict).toBe("mergeable");
    expect(output.conditions).not.toContain("No positive mechanical verification evidence was provided.");
  });

  it("does not block workspace checks for common zero-failure test summaries", async () => {
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
        nodeEvalCommand("console.log('Tests: 42 passed, 0 failed')")
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      verdict: string;
      final_verdict: string;
      must_fix: Array<{ evidence?: string }>;
    };

    expect(output.verdict).toBe("open_pr");
    expect(output.final_verdict).toBe("mergeable");
    expect(output.must_fix).toHaveLength(0);
  });

  it("redacts secret-like values from workspace output and artifacts", async () => {
    const dir = await createCleanRepo();
    const gitHubToken = "ghp_123456789012345678901234";
    const openAiKey = "sk-123456789012345678901234";
    await writeFile(join(dir, "greeting.txt"), `hello\nexport const token = "${gitHubToken}"\n`, "utf8");

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
        "Add secret fixture.",
        "--verify-command",
        nodeEvalCommand(`console.log('api_key=${openAiKey}')`)
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      run: { artifacts_dir: string };
    };
    const diffArtifact = await readFile(join(output.run.artifacts_dir, "diff.patch"), "utf8");
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");
    const reportArtifact = await readFile(join(output.run.artifacts_dir, "report.md"), "utf8");
    const verdictArtifact = await readFile(join(output.run.artifacts_dir, "verdict.json"), "utf8");

    for (const content of [stdout, diffArtifact, logsArtifact, reportArtifact, verdictArtifact]) {
      expect(content).not.toContain(gitHubToken);
      expect(content).not.toContain(openAiKey);
    }
    expect(diffArtifact).toContain("[REDACTED]");
    expect(logsArtifact).toContain("api_key=[REDACTED]");
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
        nodeEvalCommand("process.exit(1)")
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      verdict: string;
      final_verdict: string;
      must_fix: Array<{ evidence?: string }>;
    };

    expect(output.verdict).toBe("block_pr");
    expect(output.final_verdict).toBe("not_mergeable");
    expect(output.must_fix.some((item) => item.evidence?.includes("exit code 1"))).toBe(true);
  });

  it("rejects check results when a verification command is signaled", async () => {
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
        "kill -TERM $$"
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      final_verdict: string;
      must_fix: Array<{ evidence?: string }>;
    };

    expect(output.final_verdict).toBe("not_mergeable");
    expect(output.must_fix.some((item) => item.evidence?.includes("verification failed"))).toBe(true);
  });

  it("times out long-running verification commands", async () => {
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
        nodeEvalCommand("setTimeout(() => {}, 5_000)"),
        "--verify-timeout-ms",
        "50"
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      final_verdict: string;
      must_fix: Array<{ evidence?: string }>;
      run: { verify_commands: Array<{ timed_out?: boolean; timeout_ms?: number }> };
    };

    expect(output.final_verdict).toBe("not_mergeable");
    expect(output.must_fix.some((item) => item.evidence?.includes("timed out after 50ms"))).toBe(true);
    expect(output.run.verify_commands[0]).toMatchObject({ timed_out: true, timeout_ms: 50 });
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
        nodeEvalCommand("console.log('all tests passed')"),
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
    await writePackageManifest(dir, {
      packageManager: "pnpm@10.26.0",
      scripts: {
        test: "node -e \"console.log('manifest test passed')\""
      }
    });
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

  it.each([
    [
      "non-string verifyCommands entries",
      { intent: "Update greeting text.", verifyCommands: [42] },
      "verifier.config.json verifyCommands[0] must be a non-empty string."
    ],
    [
      "blank verifyCommands entries",
      { intent: "Update greeting text.", verifyCommands: ["   "] },
      "verifier.config.json verifyCommands[0] must be a non-empty string."
    ],
    [
      "non-string base",
      { intent: "Update greeting text.", base: 42, verifyCommands: [] },
      "verifier.config.json base must be a string."
    ],
    [
      "non-boolean markdown",
      { intent: "Update greeting text.", markdown: "true", verifyCommands: [] },
      "verifier.config.json markdown must be a boolean."
    ]
  ])("rejects %s in verifier.config.json", async (_name, config, expectedError) => {
    const dir = await createChangedRepo();
    await writeFile(
      join(dir, "verifier.config.json"),
      JSON.stringify(config),
      "utf8"
    );

    const { stdout, stderr, code } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir
      ],
      "",
      { env: process.env, allowFailure: true }
    );

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(expectedError);
  });

  it("does not mark workspace checks as executed when no verify command ran", async () => {
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
        "--base",
        "HEAD"
      ],
      "",
      { env: process.env }
    );
    const output = JSON.parse(stdout) as {
      evidence_grade?: string;
      final_verdict: string;
      run: { verify_commands: unknown[] };
    };

    expect(output.evidence_grade).toBe("reported");
    expect(output.final_verdict).toBe("conditional");
    expect(output.run.verify_commands).toHaveLength(0);
  });

  it.each(["mergeable", "conditional"])(
    "fails %s gates for inconclusive workspace checks",
    async (failOn) => {
      const dir = await createCleanRepo();

      const { stdout, code } = await spawnWithInput(
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
          "--fail-on",
          failOn
        ],
        "",
        { env: process.env, allowFailure: true }
      );
      const output = JSON.parse(stdout) as { final_verdict: string };

      expect(code).toBe(1);
      expect(output.final_verdict).toBe("inconclusive");
    }
  );

  it("fails explicit inconclusive gates for inconclusive workspace checks", async () => {
    const dir = await createCleanRepo();

    const { stdout, code } = await spawnWithInput(
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
        "--fail-on",
        "inconclusive"
      ],
      "",
      { env: process.env, allowFailure: true }
    );
    const output = JSON.parse(stdout) as { final_verdict: string };

    expect(code).toBe(1);
    expect(output.final_verdict).toBe("inconclusive");
  });

  it("resolves config intentFile relative to the checked workspace", async () => {
    const dir = await createChangedRepo();
    await writeFile(join(dir, "task.md"), "Update greeting text.\n", "utf8");
    await writeFile(
      join(dir, "verifier.config.json"),
      JSON.stringify({
        intentFile: "task.md",
        verifyCommands: [nodeEvalCommand("console.log('all tests passed')")]
      }),
      "utf8"
    );

    const { stdout } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir
      ],
      "",
      { env: process.env }
    );
    const output = JSON.parse(stdout) as { final_verdict: string };

    expect(output.final_verdict).toBe("mergeable");
  });
});

async function writePackageManifest(
  dir: string,
  manifest: { packageManager?: string; scripts: Record<string, string> }
): Promise<void> {
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

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
  const dir = await createCleanRepo();
  await writeFile(join(dir, "greeting.txt"), "hello verifier\n", "utf8");
  return dir;
}

async function createCleanRepo(): Promise<string> {
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
  return dir;
}
