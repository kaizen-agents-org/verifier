import { readFile, writeFile } from "node:fs/promises";

const defects = new Set((process.env.FIXTURE_DEFECTS ?? "").split(",").filter(Boolean));
const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  process.stderr.write("usage: cli.mjs <input> <output>\n");
  process.exit(2);
}

if (defects.has("hang")) {
  setInterval(() => {}, 1_000);
} else {
  const input = await readFile(inputPath, "utf8");
  if (!defects.has("missing-output")) {
    await writeFile(outputPath, input.toUpperCase(), "utf8");
  }
  if (defects.has("stderr-noise")) {
    process.stderr.write("unexpected diagnostic noise\n");
  }
  process.stdout.write(`converted ${input.length} bytes\n`);
  if (defects.has("bad-exit")) process.exitCode = 1;
}
