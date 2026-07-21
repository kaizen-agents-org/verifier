export type TargetType =
  | "cli"
  | "api"
  | "web"
  | "electron"
  | "tauri"
  | "macos-native"
  | "windows-native"
  | "tui"
  | "mobile";

export type TrustLevel = "trusted" | "untrusted";

export type CheckKind = "runtime" | "test" | "static" | "reading";

export type ClaimPriority = "must-verify" | "nice-to-verify";
export type ClaimStatus = "verified" | "failed" | "unverified";

export interface Claim {
  id: string;
  statement: string;
  priority: ClaimPriority;
  source: IntentSource;
  plannedChecks: CheckKind[];
  status: ClaimStatus;
  evidenceIds: string[];
}

export interface IntentSource {
  tier: "primary" | "secondary";
  kind: "issue" | "user-prompt" | "spec-file" | "pr-description" | "commit-message";
  ref: string;
}

export type FindingCategory =
  | "security"
  | "data-loss"
  | "crash"
  | "regression"
  | "logic"
  | "perf"
  | "style"
  | "observation";

export type Severity = "blocker" | "major" | "minor" | "info";

export interface Finding {
  id: string;
  category: FindingCategory;
  reproduced: boolean;
  severity: Severity;
  title: string;
  location?: { file: string; line?: number };
  scenario: string;
  suggestedRepro?: string;
  claimIds: string[];
  evidenceIds: string[];
  refutation: RefutationResult;
  origin: "stage0" | "stage1" | "stage2" | "stage3" | "stage5" | "system";
  lens?: "correctness" | "security" | "regression" | "performance";
}

export interface RefutationResult {
  required: boolean;
  attempted: boolean;
  outcome: "survived" | "refuted" | "skipped";
  reproConfirmed?: boolean;
  notes?: string;
  evidenceIds: string[];
}

export interface Evidence {
  id: string;
  kind:
    | "command-output"
    | "test-result"
    | "screenshot"
    | "network-log"
    | "console-log"
    | "perf-trace"
    | "code-reading"
    | "llm-judgment";
  checkKind: CheckKind;
  summary: string;
  path: string;
  reproducible: boolean;
  command?: string;
}

export type VerdictKind = "mergeable" | "conditional" | "not_mergeable" | "inconclusive";

export interface Verdict {
  schemaVersion: 1;
  kind: VerdictKind;
  confidence: number;
  conditions: string[];
  claims: Claim[];
  findings: Finding[];
  discardedFindings: Finding[];
  evidence: Evidence[];
  run: RunMeta;
}

export interface RunMeta {
  runId: string;
  startedAt: string;
  baseRef: string;
  headRef: string;
  trustLevel: TrustLevel;
  stagesExecuted: number[];
  stagesSkipped: {
    stage: number;
    reasonCode: "env-failure" | "budget-exceeded" | "user-excluded" | "upstream-failed";
    reason: string;
  }[];
  targets: TargetType[];
  agentConfig?: {
    model: string;
    effort: string;
    maxTokens: number;
    maxSchemaRetries: number;
  };
  cost: { inputTokens: number; outputTokens: number; usd: number };
  durationMs: number;
}
