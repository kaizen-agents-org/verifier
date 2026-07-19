import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Claim } from "@verifier/core";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function writeClaims(
  runId: string,
  claims: Claim[],
  runsRoot = ".verifier/runs"
): Promise<string> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid verifier run ID: ${runId}`);
  }

  const runDir = resolve(runsRoot, runId);
  const claimsPath = resolve(runDir, "claims.json");
  await mkdir(runDir, { recursive: true });
  await writeFile(claimsPath, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
  return claimsPath;
}
