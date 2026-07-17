import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("built verifier CLI", () => {
  it("reports build provenance from the compiled command", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js", "--version", "--json"], {
      encoding: "utf8"
    });
    const result = JSON.parse(stdout) as {
      status: string;
      stale: boolean | null;
      build: { commit: string | null };
      runtime: { commit: string | null };
    };

    expect(result.status).toBe("current");
    expect(result.stale).toBe(false);
    expect(result.build.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.runtime.commit).toBe(result.build.commit);
  });

  it("reports a stale compiled command when its build commit differs from the checkout", async () => {
    const buildInfoPath = "dist/build-info.json";
    const original = await readFile(buildInfoPath, "utf8");
    const buildInfo = JSON.parse(original) as { commit: string };
    buildInfo.commit = "0".repeat(40);
    await writeFile(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");

    try {
      const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js", "--version", "--json"], {
        encoding: "utf8"
      });
      const result = JSON.parse(stdout) as { status: string; stale: boolean | null };
      expect(result.status).toBe("stale");
      expect(result.stale).toBe(true);
    } finally {
      await writeFile(buildInfoPath, original, "utf8");
    }
  });

  it("does not compare a copied package with its consumer repository HEAD", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "verifier-consumer-"));
    const installedCore = join(consumer, "node_modules", "@verifier", "core");
    await mkdir(installedCore, { recursive: true });
    await cp("dist", join(installedCore, "dist"), { recursive: true });
    await writeFile(join(consumer, "package.json"), '{"name":"consumer"}\n', "utf8");
    await execFileAsync("git", ["init"], { cwd: consumer });
    await execFileAsync("git", ["add", "package.json"], { cwd: consumer });
    await execFileAsync(
      "git",
      ["-c", "user.name=Verifier Test", "-c", "user.email=verifier@example.test", "commit", "-m", "initial"],
      { cwd: consumer }
    );

    const versionModule = pathToFileURL(join(installedCore, "dist", "version.js")).href;
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { readVersionInfo } from ${JSON.stringify(versionModule)}; console.log(JSON.stringify(await readVersionInfo()));`
    ], { encoding: "utf8" });
    const result = JSON.parse(stdout) as {
      status: string;
      stale: boolean | null;
      runtime: { commit: string | null };
    };

    expect(result.status).toBe("unverifiable");
    expect(result.stale).toBeNull();
    expect(result.runtime.commit).toBeNull();
  });

  it("does not block ANSI-colored passing Vitest lines containing failure words", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-built-"));
    const resultPath = join(dir, "verify-result.json");
    const verifyLogs = [
      "\u001b[32m✓\u001b[39m test/block-classification.test.ts \u001b[2m(\u001b[22m7 tests\u001b[2m)\u001b[22m \u001b[32m2ms\u001b[39m",
      "\u001b[33m✓\u001b[39m includes previous mechanical evaluation failure output in the next iteration issue body \u001b[33m535ms\u001b[39m",
      "Test Files 31 passed (31)",
      "Tests 316 passed (316)"
    ].join("\n");
    const prompt = `# Issue\nKeep passing test output non-blocking.\n\n# Builder result\nAdded regression coverage.\n\n# Mechanical verification\n${verifyLogs}\n\n# Changed files\ntest/example.test.ts\n\n# Decision rules\nReturn a verdict.`;

    const { stdout } = await spawnWithInput(process.execPath, ["dist/cli.js"], prompt, {
      ...process.env,
      KAIZEN_VERIFIER_RESULT_PATH: resultPath
    });
    const output = JSON.parse(stdout) as { status: string };
    const result = JSON.parse(await readFile(resultPath, "utf8")) as { status: string };

    expect(output.status).toBe("open_pr");
    expect(result.status).toBe("open_pr");
  });
});

function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`built verifier exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}
