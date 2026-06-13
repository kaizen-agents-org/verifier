# Verifier

Minimal verifier CLI for turning task context, diff, verification logs, and a
builder report into a small verdict JSON.

This is the first implementation slice. It intentionally does not implement the
full staged verifier described in `docs/`; it provides the stable JSON contract
that later LLM agents, probes, and review stages can feed.

## Install

```bash
pnpm install
pnpm build
```

## Usage

Check installation:

```bash
node packages/core/dist/cli.js --version
```

```bash
node packages/core/dist/cli.js verdict \
  --task-file task.md \
  --diff-file diff.patch \
  --verify-logs-file verify.log \
  --builder-report-file builder-report.md \
  --pretty
```

Inline values are also supported:

```bash
node packages/core/dist/cli.js \
  --task "Add signup validation" \
  --diff "diff --git a/signup.ts b/signup.ts ..." \
  --verify-logs "all tests passed" \
  --builder-report "build successful" \
  --pretty
```

## Verdict JSON

The CLI always writes JSON to stdout and exits `0` for successful judgment,
including rejected judgments. Usage or runtime errors are written to stderr and
exit `2`.

```json
{
  "schemaVersion": 1,
  "verdict": "approved",
  "must_fix": [],
  "should_fix": [],
  "confidence": 82,
  "risk": "low",
  "summary": "Approved with 0 should_fix item(s); risk is low."
}
```

`verdict` is one of:

- `approved`: no blocking signal was found and task/diff context exists.
- `rejected`: verification logs or builder report contain blocking failures.
- `pr_only`: the CLI cannot judge the implementation against task/diff context.

## Kaizen Loop Integration

When `kaizen-loop` invokes `verifier`, it calls the command with no arguments,
passes the verification prompt on stdin, and expects a compact result payload in
`KAIZEN_VERIFIER_RESULT_PATH`.

```bash
KAIZEN_VERIFIER_RESULT_PATH=.kaizen/verifier/verify-result.json \
KAIZEN_WORKSPACE_DIR="$PWD" \
verifier < prompt.txt
```

The integration payload is:

```json
{
  "status": "approved",
  "summary": "Approved with 0 should_fix item(s); risk is low.",
  "notes": "risk=low\nconfidence=82",
  "reason": ""
}
```

`status` is one of `approved`, `pr_only`, or `rejected`. `verifier` does not
create pull requests, commit changes, or approve merges; it only returns an
independent gate decision for the orchestrator.

## Development

```bash
pnpm typecheck
pnpm test
pnpm schema:check
```

`schemas/verdict.schema.json` is generated from the Zod schema in
`packages/core/src/types.ts`.
