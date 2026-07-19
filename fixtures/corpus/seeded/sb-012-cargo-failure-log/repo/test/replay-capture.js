import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const captureDir = dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await readFile(join(captureDir, "capture.json"), "utf8"));
const stdout = await readFile(join(captureDir, metadata.stdoutFile), "utf8");
const stderr = await readFile(join(captureDir, metadata.stderrFile), "utf8");

process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = metadata.exitCode;
