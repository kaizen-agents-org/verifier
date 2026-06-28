import { z } from "zod";

export const VerdictDecisionSchema = z.enum([
  "open_pr",
  "open_pr_with_warning",
  "block_pr",
  "needs_context"
]);
export type VerdictDecision = z.infer<typeof VerdictDecisionSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const FinalVerdictKindSchema = z.enum([
  "mergeable",
  "conditional",
  "not_mergeable",
  "inconclusive"
]);
export type FinalVerdictKind = z.infer<typeof FinalVerdictKindSchema>;

export const FindingSeveritySchema = z.enum(["must_fix", "should_fix"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSourceSchema = z.enum([
  "task",
  "diff",
  "verify_logs",
  "builder_report",
  "system"
]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const MinimalFindingSchema = z.object({
  source: FindingSourceSchema,
  message: z.string(),
  evidence: z.string().optional()
});
export type MinimalFinding = z.infer<typeof MinimalFindingSchema>;

export const VerdictInputSchema = z.object({
  task: z.string().default(""),
  diff: z.string().default(""),
  verifyLogs: z.string().default(""),
  builderReport: z.string().default("")
});
export type VerdictInput = z.infer<typeof VerdictInputSchema>;

export const MinimalVerdictSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: VerdictDecisionSchema,
  final_verdict: FinalVerdictKindSchema.optional(),
  must_fix: z.array(MinimalFindingSchema),
  should_fix: z.array(MinimalFindingSchema),
  conditions: z.array(z.string()).optional(),
  confidence: z.number().int().min(0).max(100),
  risk: RiskLevelSchema,
  summary: z.string(),
  run: z
    .object({
      id: z.string(),
      started_at: z.string(),
      completed_at: z.string(),
      duration_ms: z.number().int().min(0),
      workspace: z.string(),
      base_ref: z.string(),
      head_ref: z.string(),
      artifacts_dir: z.string(),
      changed_files: z.array(z.string()),
      verify_commands: z.array(
        z.object({
          command: z.string(),
          exit_code: z.number().int().nullable(),
          signal: z.string().nullable(),
          duration_ms: z.number().int().min(0),
          timed_out: z.boolean().optional(),
          timeout_ms: z.number().int().min(1).optional()
        })
      )
    })
    .optional(),
  evidence: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum([
          "intent",
          "diff",
          "verify_logs",
          "builder_report",
          "verdict",
          "markdown"
        ]),
        path: z.string(),
        summary: z.string()
      })
    )
    .optional()
});
export type MinimalVerdict = z.infer<typeof MinimalVerdictSchema>;

export const VerdictSchema = MinimalVerdictSchema;
export type Verdict = MinimalVerdict;
