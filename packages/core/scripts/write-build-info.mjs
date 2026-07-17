import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

function git(args) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" }).trim();
}

const output = {
  schemaVersion: 1,
  packageVersion: packageJson.version,
  commit: git(["rev-parse", "HEAD"]),
  builtAt: new Date().toISOString(),
  dirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0
};

const outputPath = resolve(packageRoot, "dist/build-info.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
