# Release tag checklist

The organization-level [release tag guide](https://github.com/kaizen-agents-org/.github/blob/main/docs/release-tags.md)
defines compatible component sets. Do not redefine compatibility here:
`.github/onboarding/versions.json` is the source of truth for the set installed
by the onboarding kit.

Before tagging a verifier commit, run the complete CI contract from a clean
checkout with the repository-supported Node and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:package-entry
pnpm test:built-cli
pnpm schema:check
pnpm --filter @verifier/core eval
pnpm --filter @verifier/core exec node --import tsx src/eval/fixture-run.ts
pnpm eval:relaxations
SEMANTIC_EVAL_WRITE_METRICS=false pnpm eval:semantic:ci
git diff --exit-code
```

Refresh `fixtures/metrics.json` and `fixtures/semantic-metrics.json` in a
separate change when the corpus or evaluation behavior intentionally changes.
Review and commit that evidence before running the clean-checkout commands
above; their no-output variants prevent timestamps from changing the commit
that was verified. The onboarding installer builds and links the pinned
checkout, so use `pnpm test:built-cli` to exercise that built command and its
provenance rather than relying on a stale global `verifier` link.

After publishing the tag, update the organization manifest and validate the
complete pinned set through the organization release checklist. Do not advance
the verifier pin independently of that compatible-set verification.
