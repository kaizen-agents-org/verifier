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
  must_fix: z.array(MinimalFindingSchema),
  should_fix: z.array(MinimalFindingSchema),
  confidence: z.number().int().min(0).max(100),
  risk: RiskLevelSchema,
  summary: z.string()
});
export type MinimalVerdict = z.infer<typeof MinimalVerdictSchema>;

export const VerdictSchema = MinimalVerdictSchema;
export type Verdict = MinimalVerdict;
