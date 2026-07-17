import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface BuildInfo {
  schemaVersion: 1;
  packageVersion: string;
  commit: string;
  builtAt: string;
  dirty: boolean;
}

export interface VersionInfo {
  name: "verifier";
  version: string;
  status: "current" | "stale" | "unverifiable";
  stale: boolean | null;
  build: {
    commit: string | null;
    builtAt: string | null;
    dirty: boolean | null;
  };
  runtime: {
    commit: string | null;
    dirty: boolean | null;
    packageRoot: string;
  };
}

export async function readVersionInfo(): Promise<VersionInfo> {
  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const packageRoot = resolve(dirname(modulePath), "..");
  const build = await readBuildInfo(dirname(modulePath));
  const runtime = await readRuntimeCheckout(packageRoot);
  const stale = build && runtime.commit ? build.commit !== runtime.commit : null;

  return {
    name: "verifier",
    version: build?.packageVersion ?? "0.0.0",
    status: stale === true ? "stale" : stale === false ? "current" : "unverifiable",
    stale,
    build: {
      commit: build?.commit ?? null,
      builtAt: build?.builtAt ?? null,
      dirty: build?.dirty ?? null
    },
    runtime: {
      commit: runtime.commit,
      dirty: runtime.dirty,
      packageRoot
    }
  };
}

async function readBuildInfo(moduleDir: string): Promise<BuildInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resolve(moduleDir, "build-info.json"), "utf8")) as Partial<BuildInfo>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.packageVersion !== "string" ||
      typeof parsed.commit !== "string" ||
      typeof parsed.builtAt !== "string" ||
      typeof parsed.dirty !== "boolean"
    ) {
      return undefined;
    }
    return parsed as BuildInfo;
  } catch {
    return undefined;
  }
}

async function readRuntimeCheckout(packageRoot: string): Promise<{ commit: string | null; dirty: boolean | null }> {
  try {
    const { stdout: topLevelOutput } = await execFileAsync(
      "git",
      ["-C", packageRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" }
    );
    const topLevel = await realpath(topLevelOutput.trim());
    const expectedPackageRoot = await realpath(resolve(topLevel, "packages/core"));
    if (expectedPackageRoot !== packageRoot) {
      return { commit: null, dirty: null };
    }
    const repositoryPackage = JSON.parse(await readFile(resolve(topLevel, "package.json"), "utf8")) as { name?: unknown };
    if (repositoryPackage.name !== "verifier") {
      return { commit: null, dirty: null };
    }
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8" }),
      execFileAsync("git", ["-C", packageRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" })
    ]);
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}
