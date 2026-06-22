# Verifier MVP

This document defines the current MVP scope. The long-term product design in
`SPEC.md` remains the target, but this MVP deliberately focuses on a local,
evidence-backed merge-readiness check.

## Goal

Answer this question with local evidence:

> Is this workspace change mergeable against the supplied intent, based on the
> diff and verification commands that were actually run?

The MVP is not an AI code reviewer. It does not generate claims, run agent
reviews, refute findings, or operate UI/API probe drivers yet.

## Command

```bash
verifier check \
  --base main \
  --intent-file task.md \
  --verify-command "pnpm typecheck" \
  --verify-command "pnpm test" \
  --pretty
```

`check` performs four steps:

1. Read primary intent from `--intent` or `--intent-file`.
2. Collect `git diff --no-ext-diff --binary <base>` and changed file names.
3. Run each `--verify-command` in the workspace and capture stdout, stderr,
   exit code, signal, and duration.
4. Save evidence and emit a verdict.

## Evidence Store

Each `check` run writes artifacts to:

```text
.verifier/runs/<run-id>/
  intent.txt
  diff.patch
  verify-logs.txt
  builder-report.md
  report.md
  verdict.json
```

The JSON output includes `run.artifacts_dir` and an `evidence` list so callers
can link the final verdict back to the saved files.

## Verdicts

The legacy compact field remains available as `verdict`:

- `approved`
- `rejected`
- `pr_only`

The MVP merge-readiness field is `final_verdict`:

- `mergeable`: intent, diff, and at least one verification command exist; no
  blocker or conditional risk was found.
- `conditional`: the change may be acceptable, but required evidence is missing
  or a non-blocking risk signal was found.
- `not_mergeable`: verification logs or the builder report contain a blocking
  failure.
- `inconclusive`: the diff is empty or insufficient to judge.

`conditions` lists the concrete reasons a result is not immediately mergeable.

## Configuration

`verifier check` loads `verifier.config.json` from the workspace when present:

```json
{
  "base": "main",
  "intentFile": "task.md",
  "verifyCommands": ["pnpm typecheck", "pnpm test"],
  "outputDir": ".verifier/runs",
  "markdown": false,
  "failOn": "not_mergeable"
}
```

CLI flags override config values. `--verify-command` is repeatable; when at
least one is supplied on the CLI, it replaces `verifyCommands` from config.

## CI Gate

`check` exits `0` when judgment completes. Use `--fail-on` to convert verdicts
into CI failures:

```bash
verifier check --fail-on not_mergeable
verifier check --fail-on conditional
```

The gate behavior is:

- `not_mergeable`: fail only on `not_mergeable`.
- `conditional`: fail on `conditional`, `not_mergeable`, or `inconclusive`.
- `inconclusive`: fail on `inconclusive` or `not_mergeable`.
- `mergeable`: fail on anything other than `mergeable`.

## Explicit Non-goals For This MVP

- AI claim extraction.
- AI multi-lens review.
- Adversarial refutation.
- Generated tests.
- Playwright, API, TUI, Electron, or native app probe drivers.
- GitHub App or PR comment publishing.
- Untrusted code sandboxing.

Those belong to later stages once the local run/evidence/verdict contract is
stable.
