import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { KaizenVerifierResultSchema, VerdictSchema } from "../packages/core/src/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function writeGeneratedSchema(schema: ZodTypeAny, name: string, filename: string) {
  const generated = zodToJsonSchema(schema, {
    name,
    target: "jsonSchema7"
  });
  const withMetadata = {
    $id: `https://github.com/kaizen-agents-org/verifier/schemas/${filename}`,
    ...generated
  };
  await writeFile(resolve(repoRoot, "schemas", filename), `${JSON.stringify(withMetadata, null, 2)}\n`);
}

await Promise.all([
  writeGeneratedSchema(VerdictSchema, "Verdict", "verdict.schema.json"),
  writeGeneratedSchema(KaizenVerifierResultSchema, "KaizenVerifierResult", "kaizen-verifier-result.schema.json")
]);
