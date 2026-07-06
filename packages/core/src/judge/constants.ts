import type { CheckKind, ClaimPriority, Severity } from "./types.js";

export const CLAIM_WEIGHTS: Record<ClaimPriority, number> = {
  "must-verify": 2,
  "nice-to-verify": 1
};

export const CHECK_KIND_STRENGTHS: Record<CheckKind, number> = {
  runtime: 1,
  test: 0.9,
  static: 0.7,
  reading: 0.5
};

export const FINDING_SEVERITY_PENALTIES: Record<Severity, number> = {
  blocker: 15,
  major: 8,
  minor: 2,
  info: 1
};
