---
name: verifier
description: Judge whether orchestration should open, warn on, block, or request context for a PR from task text, diff, verification logs, and builder report by running the local verifier CLI.
---

# Verifier Skill

Use this skill when you need a compact verdict for a proposed change and have
some or all of:

- task or intent text
- diff or patch text
- verification logs
- builder report

## Workflow

1. Build the CLI if needed:

   ```bash
   pnpm build
   ```

2. Run the CLI with file inputs when possible:

   ```bash
   node packages/core/dist/cli.js check \
     --task-file task.md \
     --diff-file diff.patch \
     --verify-logs-file verify.log \
     --builder-report-file builder-report.md \
     --pretty
   ```

3. Treat stdout as the machine-readable result. The schema is
   `schemas/verdict.schema.json`.

`verifier check` is the canonical command. `verifier verdict` and bare options
remain available for compatibility. Spec-only staged flags such as `--base`,
`--pr`, `--intent`, `--stages`, and `--reuse-claims` are not supported by this
MVP command yet; provide explicit task and diff inputs instead.

## Output Contract

The CLI returns:

- `verdict`: `open_pr`, `open_pr_with_warning`, `block_pr`, or `needs_context`
- `must_fix`: blocking items that should prevent PR creation
- `should_fix`: non-blocking risks or missing context
- `confidence`: integer from 0 to 100
- `risk`: `low`, `medium`, or `high`
- `summary`: short human-readable explanation

The CLI exits `0` for completed judgments, including `block_pr`. It exits `2`
for usage or runtime errors.
