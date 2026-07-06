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
  --verify-timeout-ms 600000 \
  --pretty
```

`check` performs four steps:

1. Read primary intent from `--intent` or `--intent-file`.
2. Collect `git diff --no-ext-diff --binary <base>` and changed file names.
3. Run each `--verify-command` in the workspace with a bounded timeout and
   capture stdout, stderr, exit code, signal, duration, and timeout metadata.
4. Save evidence and emit a verdict.

Each command defaults to a 10 minute timeout. Use `--verify-timeout-ms` or
`verifyTimeoutMs` in `verifier.config.json` to override it. When a command times
out, `check` terminates it, records `timed_out` / `timeout_ms` in the verdict,
and treats the command as failed verification evidence.

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
can link the final verdict back to the saved files. Workspace verdict JSON and
saved artifact contents redact common secret-like values, including API keys,
bearer tokens, and password/token assignments.

Verdicts also include `evidence_grade`:

- `executed`: verifier ran at least one workspace verification command and
  recorded its exit metadata.
- `reported`: verifier judged caller-supplied text, such as direct
  `--verify-logs` input or kaizen-loop stdin sections, or no workspace
  verification command was configured.

## Verdicts

The legacy compact field remains available as `verdict`:

- `open_pr`
- `open_pr_with_warning`
- `block_pr`
- `needs_context`

The compact gate is intentionally conservative:

- `open_pr` requires intent, diff, and positive mechanical verification
  evidence.
- `open_pr_with_warning` is used for non-blocking risk signals, including
  high-risk changes that have targeted verification evidence but still warrant
  human attention.
- `block_pr` is used for verification failures, configured commands that did
  not pass, and high-risk changes without targeted verification evidence.
- `needs_context` is used when intent, diff, or positive mechanical verification
  evidence is missing.

High-risk diff checks inspect added lines, selected risky removals such as
auth/billing guard deletion, and schema/migration paths. They do not treat every
keyword in removed lines or comments as a new high-risk operation.

The MVP merge-readiness field is `final_verdict`:

- `mergeable`: intent, diff, and at least one verification command exist; no
  blocker or conditional risk was found.
- `conditional`: the change may be acceptable, but required evidence is missing
  or a non-blocking risk signal was found.
- `not_mergeable`: verification logs contain a blocking failure, a configured
  command did not pass, or high-risk changes lack targeted evidence.
- `inconclusive`: the diff is empty or insufficient to judge.

`conditions` lists the concrete reasons a result is not immediately mergeable.

## Configuration

`verifier check` loads `verifier.config.json` from the workspace when present:

```json
{
  "base": "main",
  "intentFile": "task.md",
  "verifyCommands": ["pnpm typecheck", "pnpm test"],
  "verifyTimeoutMs": 600000,
  "outputDir": ".verifier/runs",
  "markdown": false,
  "failOn": "not_mergeable"
}
```

CLI flags override config values. `--verify-command` is repeatable; when at
least one is supplied on the CLI, it replaces `verifyCommands` from config.
When neither CLI nor config commands are provided, workspace mode infers a
conservative default from root `package.json` scripts: existing `typecheck`,
`test`, and `build` scripts run in that order through the package manager named
by `packageManager` or lockfile metadata. Configure `verifyCommands`, including
an empty array, to override inference.

## CI Gate

`check` exits `0` when judgment completes. Use `--fail-on` to convert verdicts
into CI failures:

```bash
verifier check --fail-on not_mergeable
verifier check --fail-on conditional
```

The gate behavior is:

- `not_mergeable`: fail only on `not_mergeable`.
- `conditional`: fail on `conditional` or `not_mergeable`.
- `inconclusive`: fail on `inconclusive` or `not_mergeable`.
- `mergeable`: fail on `conditional` or `not_mergeable`.

Repository CI also runs `pnpm eval` so changes to the deterministic verdict
logic must continue to satisfy the committed seeded/golden corpus.

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

## Implemented Scope Matrix

| Area | MVP status |
|---|---|
| Stage 0 intent handling | Implemented as explicit `--intent` / `--intent-file` input only; no AI claim extraction. |
| Stage 1/2 verification | Implemented as user-supplied `--verify-command` execution with captured logs and exit metadata. |
| Stage 3 review agents | Not implemented; no multi-lens AI review runs in this MVP. |
| Stage 4 refutation | Not implemented; findings are deterministic log/context signals only. |
| Stage 5 probe drivers | Not implemented; no web/API/TUI/Electron/native driver orchestration. |
| Stage 6 verdict integration | Implemented as deterministic compact verdict plus workspace `final_verdict`. |
| Evidence store | Implemented for local workspace runs under `.verifier/runs/<run-id>/`. |

## Deferred Phase 2+ Scope

- AI claim extraction from primary and secondary intent sources.
- AI multi-lens review and adversarial refutation.
- Generated tests and coverage-aware evidence linking.
- Probe Driver SDK and bundled drivers for web, API, CLI, TUI, Electron, Tauri,
  and native apps.
- GitHub App / Action publishing, PR comments, and branch protection status.
- Untrusted-code execution in isolated containers.

## Known Limitations

- The MVP is TypeScript/Node-only internally and ships only `@verifier/core`.
- Workspace verification is CLI-command based; there is no structured driver
  coverage beyond spawning configured shell commands.
- Manifest inference is limited to root `package.json` scripts.
- Log classification is heuristic and pattern-based.
- Evidence is local filesystem output only; no remote artifact upload is
  implemented.

## Phase 2 Unlock Conditions

- Container isolation for untrusted PRs and reproducible command execution.
- A stable Probe Driver SDK with at least CLI, API, and web driver coverage.
- Claim/evidence data model promotion beyond the compact MVP schema.
- Evaluation fixtures that measure false positives, false negatives, and
  verdict stability before AI review/refutation is enabled by default.
