import { z } from "zod/v4";

const LocationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive().optional()
  })
  .strict();

export const CorrectnessFindingSchema = z
  .object({
    category: z.enum(["data-loss", "crash", "regression", "logic"]),
    title: z.string().min(1),
    location: LocationSchema.optional(),
    scenario: z.string().min(1),
    suggestedRepro: z.string().min(1).optional(),
    claimIds: z.array(z.string().min(1))
  })
  .strict();

export const ClaimAssessmentSchema = z
  .object({
    claimId: z.string().min(1),
    supported: z.boolean(),
    note: z.string().min(1)
  })
  .strict();

export const CorrectnessReviewSchema = z
  .object({
    findings: z.array(CorrectnessFindingSchema),
    claimAssessments: z.array(ClaimAssessmentSchema)
  })
  .strict();

export type CorrectnessFinding = z.infer<typeof CorrectnessFindingSchema>;
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;
export type CorrectnessReview = z.infer<typeof CorrectnessReviewSchema>;
