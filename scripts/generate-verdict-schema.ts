import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { VerdictSchema } from "../packages/core/src/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(repoRoot, "schemas/verdict.schema.json");

const schema = zodToJsonSchema(VerdictSchema, {
  name: "Verdict",
  target: "jsonSchema7"
});

const withMetadata = {
  $id: "https://github.com/s-hiraoku/verifier/schemas/verdict.schema.json",
  ...schema
};

await writeFile(outPath, `${JSON.stringify(withMetadata, null, 2)}\n`);
