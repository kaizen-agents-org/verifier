import { spawnSync } from "node:child_process";

const semanticPaths = /^(eval\/|packages\/agents\/|packages\/core\/src\/judge\/|packages\/core\/src\/refutation\/)/;

run(["eval:semantic", "--", "--mode", "smoke"]);

const baseSha = process.env.BASE_SHA;
const changedFiles = baseSha && !/^0+$/.test(baseSha)
  ? capture(["git", "diff", "--name-only", baseSha, "HEAD"])
  : "packages/agents/";

if (changedFiles.split(/\r?\n/).some((path) => semanticPaths.test(path))) {
  run(["eval:semantic", "--", "--mode", "full", "--output", "fixtures/semantic-metrics.json"]);
}

function run(args) {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(args) {
  const [command, ...commandArgs] = args;
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}
