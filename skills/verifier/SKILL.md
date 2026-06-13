---
name: verifier
description: Judge whether a change is approved, rejected, or PR-only from task text, diff, verification logs, and builder report by running the local verifier CLI.
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
   node packages/core/dist/cli.js verdict \
     --task-file task.md \
     --diff-file diff.patch \
     --verify-logs-file verify.log \
     --builder-report-file builder-report.md \
     --pretty
   ```

3. Treat stdout as the machine-readable result. The schema is
   `schemas/verdict.schema.json`.

## Output Contract

The CLI returns:

- `verdict`: `approved`, `rejected`, or `pr_only`
- `must_fix`: blocking items that should prevent approval
- `should_fix`: non-blocking risks or missing context
- `confidence`: integer from 0 to 100
- `risk`: `low`, `medium`, or `high`
- `summary`: short human-readable explanation

The CLI exits `0` for completed judgments, including `rejected`. It exits `2`
for usage or runtime errors.

