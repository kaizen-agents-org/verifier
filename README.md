# Verifier

Minimal verifier CLI for turning task context, workspace diff, verification
logs, and saved evidence into a merge-readiness verdict.

This is the MVP implementation slice. It intentionally does not implement the
full staged AI verifier described in `docs/SPEC.md`; it provides the local
`check` workflow, run artifacts, Markdown report, and JSON contract that later
LLM agents, probes, and review stages can feed.

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

Check the current workspace against `HEAD` and run local verification commands:

```bash
node packages/core/dist/cli.js check \
  --intent-file task.md \
  --verify-command "pnpm typecheck" \
  --verify-command "pnpm test" \
  --pretty
```

Check another workspace or compare against another base ref:

```bash
node packages/core/dist/cli.js check \
  --workspace /path/to/repo \
  --base main \
  --intent "Add signup validation" \
  --verify-command "pnpm test" \
  --pretty
```

`check` collects `git diff --no-ext-diff --binary <base>` from the workspace,
runs each `--verify-command` in that workspace, saves evidence under
`.verifier/runs/<run-id>/`, then feeds the collected diff and command logs into
the verdict contract below.

Print a Markdown report instead of JSON:

```bash
node packages/core/dist/cli.js check \
  --intent-file task.md \
  --verify-command "pnpm test" \
  --markdown
```

Fail a CI job when the final verdict reaches a threshold:

```bash
node packages/core/dist/cli.js check \
  --intent-file task.md \
  --verify-command "pnpm test" \
  --fail-on conditional
```

Configure defaults in `verifier.config.json`:

```json
{
  "base": "main",
  "intentFile": "task.md",
  "verifyCommands": ["pnpm typecheck", "pnpm test"],
  "failOn": "not_mergeable"
}
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
exit `2`. `verifier check --fail-on <kind>` exits `1` when the final verdict
matches the configured gate.

```json
{
  "schemaVersion": 1,
  "verdict": "approved",
  "final_verdict": "mergeable",
  "must_fix": [],
  "should_fix": [],
  "conditions": [],
  "confidence": 82,
  "risk": "low",
  "summary": "Mergeable with confidence 82; risk is low.",
  "run": {
    "id": "20260618084500-12345-abcdef",
    "started_at": "2026-06-18T08:45:00.000Z",
    "completed_at": "2026-06-18T08:45:02.000Z",
    "duration_ms": 2000,
    "workspace": "/path/to/repo",
    "base_ref": "main",
    "head_ref": "abc1234",
    "artifacts_dir": "/path/to/repo/.verifier/runs/20260618084500-12345-abcdef",
    "changed_files": ["src/signup.ts"],
    "verify_commands": [
      {
        "command": "pnpm test",
        "exit_code": 0,
        "signal": null,
        "duration_ms": 1234
      }
    ]
  },
  "evidence": [
    {
      "id": "E-2",
      "kind": "diff",
      "path": "diff.patch",
      "summary": "Git diff against main."
    }
  ]
}
```

`verdict` is one of:

- `approved`: no blocking signal was found and task/diff context exists.
- `rejected`: verification logs or builder report contain blocking failures.
- `pr_only`: the CLI cannot judge the implementation against task/diff context.

`final_verdict` is emitted by `check` and is one of:

- `mergeable`: intent, diff, and verification evidence are present with no blocking or conditional signal.
- `conditional`: no blocker was found, but required evidence or review context is missing.
- `not_mergeable`: verification found a blocking failure.
- `inconclusive`: the diff or execution context is insufficient to make a grounded judgment.

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

See [docs/MVP.md](./docs/MVP.md) for the current product scope and the explicit
line between this MVP and the longer-term AI verifier design.
