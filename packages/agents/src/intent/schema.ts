import { z } from "zod/v4";

export const ExtractedClaimSchema = z.object({
  statement: z.string().min(1),
  priority: z.enum(["must-verify", "nice-to-verify"]),
  plannedChecks: z.array(z.enum(["runtime", "test", "static", "reading"])),
  sourceRef: z.string().min(1)
});

export const IntentExtractionSchema = z.object({
  claims: z.array(ExtractedClaimSchema),
  conflicts: z.array(z.string().min(1))
});

export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;
export type IntentExtraction = z.infer<typeof IntentExtractionSchema>;
