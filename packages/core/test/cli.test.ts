import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function nodeEvalCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function kaizenEvidencePrompt(
  verificationRecord: string,
  diff = "diff --git a/src/lib.rs b/src/lib.rs\n+export const VERIFIED = true;"
): string {
  return `# Issue

Use mechanical verification when deciding whether to open a PR.

# Builder result

Implemented the requested change.

# Mechanical verification

- [x] cargo test

# Verification logs

<verification_logs_data>
${verificationRecord}
</verification_logs_data>

# Changed files

- src/lib.rs

# Diff

${diff}

# Decision rules

Return a verifier decision.
`;
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

  it("creates the result parent directory for the kaizen-loop stdin/result-file contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, ".kaizen", "verifier", "verify-result.json");
    const prompt = `You are the verifier for the kaizen-loop run in "repo".

# Issue #1: Add signup validation

Validate email addresses.

# Mechanical verification

- [x] issue-example-check

# Changed files

- issue-example.md

# Builder result

Implemented validation and tests.

## Difference from current behavior

The implementation validates signup input.

# Mechanical verification

- [x] pnpm test
- [x] pnpm typecheck

# Changed files

- \`src/登録.ts\`
- test/signup.test.ts

# Diff

diff --git "a/src/登録.ts" "b/src/登録.ts"
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
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as {
      schemaVersion: number;
      verdict: string;
      final_verdict: string;
      status: string;
      evidence_grade: string;
      confidence: number;
      risk: string;
      summary: string;
      reason: string;
      must_fix: unknown[];
      should_fix: unknown[];
      run: {
        workspace: string;
        artifacts_dir: string;
        changed_files: string[];
        verify_commands: unknown[];
      };
    };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      summary: string;
      notes: string;
      reason: string;
      must_fix: unknown[];
      should_fix: unknown[];
    };
    const integrationSchema = JSON.parse(
      await readFile(join(process.cwd(), "../../schemas/kaizen-verifier-result.schema.json"), "utf8")
    );
    const validateIntegrationResult = new Ajv().compile(integrationSchema);

    expect(output.status).toBe("open_pr");
    expect(output.schemaVersion).toBe(1);
    expect(output.verdict).toBe("open_pr");
    expect(output.final_verdict).toBe("mergeable");
    expect(output.evidence_grade).toBe("reported");
    expect(output.confidence).toEqual(expect.any(Number));
    expect(output.risk).toBe("low");
    expect(output.run).toMatchObject({
      workspace: await realpath(dir),
      changed_files: ["src/登録.ts", "test/signup.test.ts"],
      verify_commands: []
    });
    expect(dirname(output.run.artifacts_dir)).toBe(
      join(await realpath(dir), ".kaizen", "verifier")
    );
    expect(result).toEqual(output);
    expect(validateIntegrationResult(result), JSON.stringify(validateIntegrationResult.errors)).toBe(true);
    expect(result.status).toBe("open_pr");
    expect(result.summary).toContain("Open PR");
    expect(result.notes).toContain("evidence_grade=reported");
    expect(output.reason).toBe("");
    expect(result.reason).toBe("");
    expect(output.must_fix).toEqual([]);
    expect(output.should_fix).toEqual([]);
    expect(result.must_fix).toEqual([]);
    expect(result.should_fix).toEqual([]);
  });

  it("preserves kaizen-loop mechanical verification as executed evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-evidence-"));
    const prompt = `# Issue #357: Preserve verifier evidence

Use the mechanical verification results when deciding whether to open a PR.

# Builder result

Implemented the requested change.

# Mechanical verification

- [x] cargo test
- [x] cargo clippy

# Verification logs

<verification_logs_data>
\`\`\`\`markdown
## Command 1

Status: passed

Command:
\`\`\`sh
cargo test
\`\`\`

Output:
\`\`\`text
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
\`\`\`

## Command 2

Status: passed

Command:
\`\`\`sh
cargo clippy
\`\`\`

Output:
\`\`\`text
Finished dev profile [unoptimized + debuginfo] target(s) in 9.27s
\`\`\`
\`\`\`\`
</verification_logs_data>

# Changed files

- src/lib.rs

# Diff

diff --git a/src/lib.rs b/src/lib.rs
+pub const VERIFIED: bool = true;

# Decision rules

Return a verifier decision.
`;

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as {
      evidence_grade: string;
      run: {
        artifacts_dir: string;
        verify_commands: Array<{
          command: string;
          exit_code: number | null;
          signal: string | null;
          duration_ms: number;
        }>;
      };
    };

    expect(output.evidence_grade).toBe("executed");
    expect(output.run.verify_commands).toEqual([
      { command: "cargo test", exit_code: 0, signal: null, duration_ms: 0 },
      { command: "cargo clippy", exit_code: 0, signal: null, duration_ms: 0 }
    ]);
    await expect(readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8"))
      .resolves.toContain("test result: ok. 3 passed; 0 failed");
  });

  it("blocks kaizen-loop results when a canonical verification command failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-failed-evidence-"));
    const prompt = kaizenEvidencePrompt(`\`\`\`\`markdown
## Command 1

Status: failed

Command:
\`\`\`sh
cargo test
\`\`\`

Output:
\`\`\`text
No details available
\`\`\`
\`\`\`\``);

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );
    const output = JSON.parse(stdout) as {
      verdict: string;
      final_verdict: string;
      evidence_grade: string;
      must_fix: Array<{ evidence?: string }>;
      run: { verify_commands: Array<{ command: string; exit_code: number | null }> };
    };

    expect(output.verdict).toBe("block_pr");
    expect(output.final_verdict).toBe("not_mergeable");
    expect(output.evidence_grade).toBe("executed");
    expect(output.must_fix.some((finding) =>
      finding.evidence?.includes("canonical record 1")
    )).toBe(true);
    expect(output.run.verify_commands).toEqual([
      expect.objectContaining({ command: "cargo test", exit_code: null })
    ]);
  });

  it("ignores canonical-looking verification records outside the verification section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-diff-evidence-"));
    const canonicalRecord = `\`\`\`\`markdown
## Command 1

Status: passed

Command:
\`\`\`sh
cargo test
\`\`\`

Output:
\`\`\`text
All tests passed
\`\`\`
\`\`\`\``;
    const prompt = kaizenEvidencePrompt(
      "Verification logs were not available.",
      `diff --git a/src/lib.rs b/src/lib.rs
+const evidence = \`<verification_logs_data>\n${canonicalRecord}\n</verification_logs_data>\`;`
    );

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );
    const output = JSON.parse(stdout) as {
      evidence_grade: string;
      run: { verify_commands: unknown[] };
    };

    expect(output.evidence_grade).toBe("reported");
    expect(output.run.verify_commands).toEqual([]);
  });

  it("rejects canonical records closed early by a three-backtick outer fence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-fence-evidence-"));
    const prompt = kaizenEvidencePrompt(`\`\`\`markdown
## Command 1

Status: passed

Command:
\`\`\`sh
cargo test
\`\`\`

Output:
\`\`\`text
All tests passed
\`\`\`
\`\`\``);

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );
    const output = JSON.parse(stdout) as {
      evidence_grade: string;
      run: { verify_commands: unknown[] };
    };

    expect(output.evidence_grade).toBe("reported");
    expect(output.run.verify_commands).toEqual([]);
  });

  it("persists redacted prompt evidence for the kaizen-loop stdin contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-artifacts-"));
    const prompt = `# Issue
Add signup validation. token=task-secret

# Builder result
Implemented validation. password=builder-secret

# Mechanical verification
pnpm test passed. api_key=logs-secret

# Changed files
- src/signup.ts

# Diff
diff --git a/src/signup.ts b/src/signup.ts
+const token = "diff-secret";

# Decision rules
Return a verifier decision.
`;

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      prompt,
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as {
      final_verdict: string;
      run: { artifacts_dir: string };
    };
    const artifactNames = [
      "intent.txt",
      "diff.patch",
      "verify-logs.txt",
      "builder-report.md",
      "report.md",
      "verdict.json"
    ];
    const artifactContents = await Promise.all(
      artifactNames.map((name) => readFile(join(output.run.artifacts_dir, name), "utf8"))
    );

    expect(artifactContents[0]).toContain("Add signup validation");
    expect(artifactContents[1]).toContain("diff --git a/src/signup.ts b/src/signup.ts");
    expect(artifactContents[2]).toContain("pnpm test passed");
    expect(artifactContents[3]).toContain("Implemented validation");
    expect(artifactContents[4]).toContain(`# Verifier Verdict: ${output.final_verdict}`);
    expect(JSON.parse(artifactContents[5])).toEqual(output);
    expect(artifactContents.join("\n")).not.toMatch(
      /task-secret|builder-secret|logs-secret|diff-secret/
    );
    expect(artifactContents.slice(0, 4).every((content) => content.includes("[REDACTED]"))).toBe(true);
  });

  it("does not replace project files that share artifact names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-artifact-replace-"));
    const artifactsDir = join(dir, ".kaizen", "verifier");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "intent.txt"), `stale-content-${"x".repeat(4096)}`, "utf8");

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      kaizenLoopPrompt(),
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
    await expect(readFile(join(artifactsDir, "intent.txt"), "utf8")).resolves.toContain(
      "stale-content"
    );
    await expect(readFile(join(output.run.artifacts_dir, "intent.txt"), "utf8")).resolves.not.toContain(
      "stale-content"
    );
  });

  it.each(["intent.txt", "report.md", "REPORT.MD", "verdict.json"])(
    "isolates artifacts from result path basename %s",
    async (filename) => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-result-collision-"));
      const { stdout } = await spawnWithInput(
        process.execPath,
        ["--import", "tsx", "src/cli.ts"],
        kaizenLoopPrompt(),
        {
          env: {
            ...process.env,
            KAIZEN_VERIFIER_RESULT_PATH: `.kaizen/verifier/${filename}`,
            KAIZEN_WORKSPACE_DIR: dir
          }
        }
      );

      const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
      await expect(
        readFile(join(dir, ".kaizen", "verifier", filename), "utf8")
      ).resolves.toBe(stdout);
      await expect(
        readFile(join(output.run.artifacts_dir, "report.md"), "utf8")
      ).resolves.toContain("# Verifier Verdict:");
    }
  );

  it.runIf(process.platform !== "win32")(
    "does not follow symbolic links when writing kaizen-loop evidence",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-artifact-link-"));
      const artifactsDir = join(dir, ".kaizen", "verifier");
      const outsidePath = join(dir, "outside.txt");
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(outsidePath, "unchanged", "utf8");
      await symlink(outsidePath, join(artifactsDir, "intent.txt"));

      const { stdout } = await spawnWithInput(
        process.execPath,
        ["--import", "tsx", "src/cli.ts"],
        kaizenLoopPrompt(),
        {
          env: {
            ...process.env,
            KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
            KAIZEN_WORKSPACE_DIR: dir
          }
        }
      );

      const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
      await expect(readFile(outsidePath, "utf8")).resolves.toBe("unchanged");
      await expect(readFile(join(output.run.artifacts_dir, "intent.txt"), "utf8")).resolves.toBeTruthy();
    }
  );

  it("rejects a multiply-linked Kaizen artifact before truncating it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-kaizen-artifact-link-"));
    const artifactsDir = join(dir, ".kaizen", "verifier");
    const outsidePath = join(dir, "outside.txt");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(outsidePath, "preserve me\n", "utf8");
    await link(outsidePath, join(artifactsDir, "intent.txt"));

    const { stdout } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      kaizenLoopPrompt(),
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("preserve me\n");
    await expect(readFile(join(output.run.artifacts_dir, "intent.txt"), "utf8")).resolves.toBeTruthy();
  });

  it.runIf(process.platform !== "win32")(
    "reports canonical Kaizen workspace and artifact paths through a workspace symlink",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-workspace-link-"));
      const workspace = join(dir, "workspace");
      const linkedWorkspace = join(dir, "linked-workspace");
      await mkdir(workspace);
      await symlink(workspace, linkedWorkspace);

      const { stdout } = await spawnWithInput(
        process.execPath,
        ["--import", "tsx", "src/cli.ts"],
        kaizenLoopPrompt(),
        {
          env: {
            ...process.env,
            KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
            KAIZEN_WORKSPACE_DIR: linkedWorkspace
          }
        }
      );

      const output = JSON.parse(stdout) as {
        run: { workspace: string; artifacts_dir: string };
      };
      const canonicalWorkspace = await realpath(workspace);

      expect(output.run.workspace).toBe(canonicalWorkspace);
      expect(dirname(output.run.artifacts_dir)).toBe(join(canonicalWorkspace, ".kaizen", "verifier"));
      await expect(
        readFile(join(canonicalWorkspace, ".kaizen", "verifier", "verify-result.json"), "utf8")
      ).resolves.toBe(stdout);
    }
  );

  it.each(["relative", "absolute"] as const)(
    "rejects a %s kaizen-loop result path outside the workspace",
    async (pathKind) => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-boundary-"));
      const workspace = join(dir, "workspace");
      const outsidePath = join(dir, `${pathKind}-result.json`);
      await mkdir(workspace);
      const resultPath = pathKind === "relative" ? `../${pathKind}-result.json` : outsidePath;

      const { stderr, code } = await spawnWithInput(
        process.execPath,
        ["--import", "tsx", "src/cli.ts"],
        kaizenLoopPrompt(),
        {
          env: {
            ...process.env,
            KAIZEN_VERIFIER_RESULT_PATH: resultPath,
            KAIZEN_WORKSPACE_DIR: workspace
          },
          allowFailure: true
        }
      );

      expect(code).toBe(2);
      expect(stderr).toContain("KAIZEN_VERIFIER_RESULT_PATH must stay within KAIZEN_WORKSPACE_DIR");
      await expect(readFile(outsidePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("rejects a kaizen-loop result path that escapes through a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-boundary-"));
    const workspace = join(dir, "workspace");
    const outsideDir = join(dir, "outside");
    const outsidePath = join(outsideDir, "verify-result.json");
    await mkdir(workspace);
    await mkdir(outsideDir);
    await symlink(outsideDir, join(workspace, "results"));

    const { stderr, code } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      kaizenLoopPrompt(),
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: "results/verify-result.json",
          KAIZEN_WORKSPACE_DIR: workspace
        },
        allowFailure: true
      }
    );

    expect(code).toBe(2);
    expect(stderr).toContain("KAIZEN_VERIFIER_RESULT_PATH resolves outside KAIZEN_WORKSPACE_DIR");
    await expect(readFile(outsidePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a multiply-linked result file before truncating it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-boundary-"));
    const workspace = join(dir, "workspace");
    const outsidePath = join(dir, "outside-result.json");
    const resultPath = join(workspace, "verify-result.json");
    await mkdir(workspace);
    await writeFile(outsidePath, "preserve me\n", "utf8");
    await link(outsidePath, resultPath);

    const { stderr, code } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts"],
      kaizenLoopPrompt(),
      {
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: "verify-result.json",
          KAIZEN_WORKSPACE_DIR: workspace
        },
        allowFailure: true
      }
    );

    expect(code).toBe(2);
    expect(stderr).toContain("KAIZEN_VERIFIER_RESULT_PATH changed before it could be written safely");
    expect(await readFile(outsidePath, "utf8")).toBe("preserve me\n");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO result path without waiting for a reader",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-boundary-"));
      const workspace = join(dir, "workspace");
      const resultPath = join(workspace, "verify-result.json");
      await mkdir(workspace);
      await execFileAsync("mkfifo", [resultPath]);

      const { stderr, code } = await spawnWithInput(
        process.execPath,
        ["--import", "tsx", "src/cli.ts"],
        kaizenLoopPrompt(),
        {
          env: {
            ...process.env,
            KAIZEN_VERIFIER_RESULT_PATH: "verify-result.json",
            KAIZEN_WORKSPACE_DIR: workspace
          },
          allowFailure: true
        }
      );

      expect(code).toBe(2);
      expect(stderr).toContain("KAIZEN_VERIFIER_RESULT_PATH must be a regular file");
    }
  );

  it.runIf(process.platform !== "win32")(
    "rejects a reader-attached FIFO before consuming stdin",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-boundary-"));
      const workspace = join(dir, "workspace");
      const resultPath = join(workspace, "verify-result.json");
      await mkdir(workspace);
      await execFileAsync("mkfifo", [resultPath]);
      const reader = await open(resultPath, constants.O_RDONLY | constants.O_NONBLOCK);

      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: "verify-result.json",
          KAIZEN_WORKSPACE_DIR: workspace
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      let timeout: NodeJS.Timeout | undefined;
      let code: number | null;
      try {
        code = await Promise.race([
          new Promise<number | null>((resolve) => child.once("close", resolve)),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("verifier waited for stdin")),
              10_000
            );
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
        await reader.close();
      }

      expect(code).toBe(2);
      expect(stderr).toContain("KAIZEN_VERIFIER_RESULT_PATH must be a regular file");
    }
  );

  it("rejects a result path replaced after the file is pre-opened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-boundary-"));
    const workspace = join(dir, "workspace");
    const resultPath = join(workspace, "verify-result.json");
    const openedPath = join(workspace, "pre-opened-result.json");
    const outsidePath = join(dir, "outside-result.json");
    await mkdir(workspace);
    await writeFile(outsidePath, "preserve me\n", "utf8");

    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KAIZEN_VERIFIER_RESULT_PATH: "verify-result.json",
        KAIZEN_WORKSPACE_DIR: workspace
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await waitForPath(resultPath);
    await rename(resultPath, openedPath);
    await symlink(outsidePath, resultPath);
    child.stdin.end(kaizenLoopPrompt());
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(2);
    expect(stderr).toContain("KAIZEN_VERIFIER_RESULT_PATH resolves outside KAIZEN_WORKSPACE_DIR");
    expect(await readFile(outsidePath, "utf8")).toBe("preserve me\n");
    expect(await readFile(openedPath, "utf8")).toBe("");
  });

  it.runIf(process.platform !== "win32")(
    "rejects an artifact directory replaced before evidence is written",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "verifier-artifact-directory-race-"));
      const workspace = join(dir, "workspace");
      const resultDir = join(workspace, ".kaizen", "verifier");
      const movedResultDir = join(workspace, ".kaizen", "verifier-original");
      const outsideDir = join(dir, "outside");
      const resultPath = join(resultDir, "verify-result.json");
      await mkdir(workspace);
      await mkdir(outsideDir);

      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: ".kaizen/verifier/verify-result.json",
          KAIZEN_WORKSPACE_DIR: workspace
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      await waitForPath(resultPath);
      while (!(await readdir(resultDir)).some((name) => name.startsWith(".verifier-artifacts-"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await rename(resultDir, movedResultDir);
      await symlink(outsideDir, resultDir);
      child.stdin.end(kaizenLoopPrompt());
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

      expect(code).toBe(2);
      expect(stderr).toContain("Kaizen artifact directory changed before it could be written safely");
      await expect(readFile(join(outsideDir, "intent.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it("needs context for kaizen-loop prompts with only a changed-file inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `# Issue

Add signup validation.

# Builder result

Implemented validation and tests.

## Difference from current behavior

The implementation validates signup input.

# Mechanical verification

- [x] pnpm test

# Changed files

src/signup.ts
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
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as {
      status: string;
      final_verdict: string;
      reason: string;
      run: { changed_files: string[] };
      must_fix: unknown[];
      should_fix: Array<{ source: string; message: string; evidence?: string }>;
    };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      reason: string;
      must_fix: unknown[];
      should_fix: Array<{ source: string; message: string; evidence?: string }>;
    };

    expect(output.status).toBe("needs_context");
    expect(output.final_verdict).toBe("inconclusive");
    expect(output.run.changed_files).toEqual(["src/signup.ts", "test/signup.test.ts"]);
    expect(result.status).toBe("needs_context");
    expect(output.reason).toContain("Diff is missing");
    expect(result.reason).toContain("Diff is missing");
    expect(output.must_fix).toEqual([]);
    expect(output.should_fix).toEqual(result.should_fix);
    expect(output.should_fix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "diff",
          message: expect.stringContaining("Diff is missing")
        })
      ])
    );
  });

  it("keeps a kaizen-loop result conditional when verification evidence is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `# Issue

Add signup validation.

# Builder result

Implemented validation.

# Mechanical verification

Not configured.

# Changed files

- src/signup.ts

# Diff

diff --git a/src/signup.ts b/src/signup.ts
+validateEmail(input.email)

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
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as {
      status: string;
      final_verdict: string;
      reason: string;
    };

    expect(output.status).toBe("needs_context");
    expect(output.final_verdict).toBe("conditional");
    expect(output.reason).toContain("No positive mechanical verification evidence");
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(output);
  });

  it("ignores a Diff heading embedded before the generated changed-files section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `# Issue

Document the expected input:

\`\`\`text
# Diff
diff --git a/example.ts b/example.ts
+example
\`\`\`

# Builder result

Implemented the requested change.

# Mechanical verification

- [x] pnpm test

# Changed files

- src/example.ts

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
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as { status: string; reason: string };

    expect(output.status).toBe("needs_context");
    expect(output.reason).toContain("Diff is missing");
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

    const output = JSON.parse(stdout) as {
      status: string;
      reason: string;
      must_fix: Array<{ source: string; message: string; evidence?: string }>;
      should_fix: unknown[];
    };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      notes: string;
      reason: string;
      must_fix: Array<{ source: string; message: string; evidence?: string }>;
      should_fix: unknown[];
    };

    expect(output.status).toBe("block_pr");
    expect(result.status).toBe("block_pr");
    expect(output.reason).toContain("focused verification");
    expect(result.reason).toContain("focused verification");
    expect(result.notes).toContain("Diff touches high-risk billing/payments code");
    expect(output.must_fix).toEqual(result.must_fix);
    expect(output.must_fix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "diff",
          message: expect.stringContaining("focused verification"),
          evidence: expect.stringContaining("billing/payments")
        })
      ])
    );
    expect(output.should_fix).toEqual([]);
  });

  it("preserves structured warnings for kaizen-loop prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-"));
    const resultPath = join(dir, "verify-result.json");
    const prompt = `# Issue #3: Preserve billing token handling

Keep payment token handling covered by focused verification.

# Builder result

Changed billing token extraction and added billing coverage.

# Mechanical verification

- [x] pnpm test -- billing

# Changed files

- src/billing.ts

# Diff

diff --git a/src/billing.ts b/src/billing.ts
+const token = "ghp_12345678901234567890"

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
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir
        }
      }
    );

    const output = JSON.parse(stdout) as {
      status: string;
      must_fix: unknown[];
      should_fix: Array<{ source: string; message: string; evidence?: string }>;
    };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      must_fix: unknown[];
      should_fix: Array<{ source: string; message: string; evidence?: string }>;
    };

    expect(output.status).toBe("open_pr_with_warning");
    expect(stdout).not.toContain("ghp_12345678901234567890");
    expect(await readFile(resultPath, "utf8")).not.toContain("ghp_12345678901234567890");
    expect(output.must_fix).toEqual([]);
    expect(output.should_fix).toEqual(result.should_fix);
    expect(output.should_fix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "diff",
          message: expect.stringContaining("high-risk billing/payments code"),
          evidence: expect.stringMatching(/src\/billing\.ts[\s\S]*\[REDACTED\]/)
        })
      ])
    );
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

  it("infers the merge base of origin/HEAD for committed workspace changes", async () => {
    const { dir, mergeBaseSha } = await createCommittedBranchRepo();

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
      run: { artifacts_dir: string; base_ref: string; changed_files: string[] };
    };

    expect(output.run.base_ref).toBe(mergeBaseSha);
    expect(output.run.changed_files).toEqual(["greeting.txt"]);
    const diff = await readFile(join(output.run.artifacts_dir, "diff.patch"), "utf8");
    expect(diff).toContain("+hello verifier");
    expect(diff).not.toContain("upstream.txt");
  });

  it("writes workspace evidence to a custom relative output directory", async () => {
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
        nodeEvalCommand("console.log('all tests passed')"),
        "--output-dir",
        "artifacts/verifier"
      ],
      "",
      { env: process.env }
    );
    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };

    expect(output.run.artifacts_dir.startsWith(join(dir, "artifacts", "verifier"))).toBe(true);
    await expect(readFile(join(output.run.artifacts_dir, "verdict.json"), "utf8")).resolves.toContain("mergeable");
  });

  it("rejects an absolute --output-dir", async () => {
    const dir = await createChangedRepo();
    const outside = await mkdtemp(join(tmpdir(), "verifier-output-"));

    const { stdout, stderr, code } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir,
        "--output-dir",
        outside
      ],
      "",
      { env: process.env, allowFailure: true }
    );

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("outputDir must be a relative path within the workspace.");
  });

  it("rejects a verifier.config.json outputDir that escapes the workspace", async () => {
    const dir = await createChangedRepo();
    await writeFile(
      join(dir, "verifier.config.json"),
      JSON.stringify({ outputDir: "../outside", verifyCommands: [] }),
      "utf8"
    );

    const { stdout, stderr, code } = await spawnWithInput(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "check", "--workspace", dir],
      "",
      { env: process.env, allowFailure: true }
    );

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("outputDir must stay within the workspace.");
  });

  it("rejects an outputDir symlink that resolves outside the workspace", async () => {
    const dir = await createChangedRepo();
    const outside = await mkdtemp(join(tmpdir(), "verifier-output-"));
    await symlink(outside, join(dir, "outside-link"));

    const { stdout, stderr, code } = await spawnWithInput(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "check",
        "--workspace",
        dir,
        "--output-dir",
        "outside-link"
      ],
      "",
      { env: process.env, allowFailure: true }
    );

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("outputDir resolves outside the workspace.");
  });

  it("bounds noisy verification command stdout and stderr while preserving head and tail", async () => {
    const dir = await createChangedRepo();
    const noisyCommand = nodeEvalCommand([
      "process.stdout.write('stdout-head-' + 'o'.repeat(131072) + '-stdout-tail')",
      "process.stderr.write('stderr-head-' + 'e'.repeat(131072) + '-stderr-tail')"
    ].join(";"));

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
        noisyCommand
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      run: {
        artifacts_dir: string;
        verify_commands: Array<{ exit_code: number | null; timed_out?: boolean }>;
      };
    };
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");

    expect(output.run.verify_commands[0]).toMatchObject({ exit_code: 0, timed_out: false });
    expect(logsArtifact).toContain("stdout-head-");
    expect(logsArtifact).toContain("-stdout-tail");
    expect(logsArtifact).toContain("stderr-head-");
    expect(logsArtifact).toContain("-stderr-tail");
    expect(logsArtifact).toContain(
      "stdout truncated: omitted 65560 bytes; showing first 32768 and last 32768 bytes"
    );
    expect(logsArtifact).toContain(
      "stderr truncated: omitted 65560 bytes; showing first 32768 and last 32768 bytes"
    );
    expect(Buffer.byteLength(logsArtifact)).toBeLessThan(132 * 1024);
  });

  it("redacts credentials before noisy verification output is truncated", async () => {
    const dir = await createChangedRepo();
    const credential = "boundary-secret-value";
    const noisyCommand = nodeEvalCommand([
      "process.stdout.write('x'.repeat(98298) + 'token=')",
      "setTimeout(() => process.stdout.write(['boundary', 'secret', 'value'].join('-') + 'z'.repeat(32768)), 10)"
    ].join(";"));

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
        noisyCommand
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");

    expect(logsArtifact).toContain("token=[REDACTED]");
    expect(logsArtifact).not.toContain(credential);
  });

  it("measures truncation after verification output is redacted", async () => {
    const dir = await createChangedRepo();
    const noisyCommand = nodeEvalCommand(
      "process.stdout.write('token=' + 's'.repeat(102400) + '\\nvisible-output')"
    );

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
        noisyCommand
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");

    expect(logsArtifact).toContain("token=[REDACTED]");
    expect(logsArtifact).toContain("visible-output");
    expect(logsArtifact).not.toContain("stdout truncated:");
  });

  it("preserves truncation metadata after a sensitive assignment prefix", async () => {
    const dir = await createChangedRepo();
    const noisyCommand = nodeEvalCommand(
      "process.stdout.write('x'.repeat(32754) + 'authorization: hidden-value\\n' + 'z'.repeat(65536))"
    );

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
        noisyCommand
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");

    expect(logsArtifact).toContain("authorization:");
    expect(logsArtifact).toContain("stdout truncated: omitted");
    expect(logsArtifact).not.toContain("hidden-value");
  });

  it("keeps multibyte characters intact at bounded capture edges", async () => {
    const dir = await createChangedRepo();
    const noisyCommand = nodeEvalCommand(
      "const smile = String.fromCodePoint(0x1f642); "
      + "process.stdout.write('a'.repeat(32767) + smile + 'm'.repeat(32768) + smile + 'z'.repeat(32767))"
    );

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
        noisyCommand
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as { run: { artifacts_dir: string } };
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");

    expect(logsArtifact).toContain(
      "stdout truncated: omitted 32768 bytes; showing first 32771 and last 32771 bytes"
    );
    expect(logsArtifact.match(/🙂/gu)).toHaveLength(2);
    expect(logsArtifact).not.toContain("�");
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
        nodeEvalCommand([
          "process.on('SIGTERM', () => { process.stderr.write('late-stderr-'.repeat(4000)); process.exit(1) })",
          "setTimeout(() => {}, 5_000)"
        ].join(";")),
        "--verify-timeout-ms",
        "50"
      ],
      "",
      { env: process.env }
    );

    const output = JSON.parse(stdout) as {
      final_verdict: string;
      must_fix: Array<{ evidence?: string }>;
      run: {
        artifacts_dir: string;
        verify_commands: Array<{ timed_out?: boolean; timeout_ms?: number }>;
      };
    };

    expect(output.final_verdict).toBe("not_mergeable");
    expect(output.must_fix.some((item) => item.evidence?.includes("timed out after 50ms"))).toBe(true);
    expect(output.run.verify_commands[0]).toMatchObject({ timed_out: true, timeout_ms: 50 });
    const logsArtifact = await readFile(join(output.run.artifacts_dir, "verify-logs.txt"), "utf8");
    expect(logsArtifact).toContain("late-stderr-");
    expect(logsArtifact).toContain("verification command timed out after 50ms");
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

function kaizenLoopPrompt(): string {
  return `# Issue

Keep verifier artifacts inside the workspace.

# Builder result

Added a result path check.

# Mechanical verification

- [x] pnpm test

# Changed files

- packages/core/src/cli.ts

# Diff

diff --git a/packages/core/src/cli.ts b/packages/core/src/cli.ts
+validateResultPath()

# Decision rules

Return a verdict.
`;
}

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

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function createChangedRepo(): Promise<string> {
  const dir = await createCleanRepo();
  await writeFile(join(dir, "greeting.txt"), "hello verifier\n", "utf8");
  return dir;
}

async function createCommittedBranchRepo(): Promise<{ dir: string; mergeBaseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "verifier-committed-check-"));
  await writeFile(join(dir, "greeting.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
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
  const { stdout: mainSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  await execFileAsync(
    "git",
    ["update-ref", "refs/remotes/origin/main", mainSha.trim()],
    { cwd: dir }
  );
  await execFileAsync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    { cwd: dir }
  );
  await execFileAsync("git", ["switch", "-c", "feature"], { cwd: dir });
  await writeFile(join(dir, "greeting.txt"), "hello verifier\n", "utf8");
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
      "update greeting"
    ],
    { cwd: dir }
  );
  await execFileAsync("git", ["switch", "main"], { cwd: dir });
  await writeFile(join(dir, "upstream.txt"), "upstream only\n", "utf8");
  await execFileAsync("git", ["add", "upstream.txt"], { cwd: dir });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Verifier",
      "-c",
      "user.email=verifier@example.test",
      "commit",
      "-m",
      "advance main"
    ],
    { cwd: dir }
  );
  const { stdout: advancedMainSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  await execFileAsync(
    "git",
    ["update-ref", "refs/remotes/origin/main", advancedMainSha.trim()],
    { cwd: dir }
  );
  await execFileAsync("git", ["switch", "feature"], { cwd: dir });
  return { dir, mergeBaseSha: mainSha.trim() };
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
