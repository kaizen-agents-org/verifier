import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Claim } from "@verifier/core";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function writeClaims(
  runId: string,
  claims: Claim[],
  runsRoot = ".verifier/runs"
): Promise<string> {
  return writeJsonArtifact(runId, "claims.json", claims, runsRoot);
}

export async function writeJsonArtifact(
  runId: string,
  artifactName: string,
  value: unknown,
  runsRoot = ".verifier/runs"
): Promise<string> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid verifier run ID: ${runId}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(artifactName)) {
    throw new Error(`Invalid verifier artifact name: ${artifactName}`);
  }

  const runDir = resolve(runsRoot, runId);
  const artifactPath = resolve(runDir, artifactName);
  await mkdir(runDir, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return artifactPath;
}
