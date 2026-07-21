import { z } from "zod/v4";

export const RefuterOutputSchema = z
  .object({
    outcome: z.enum(["survived", "refuted"]),
    reasoning: z.string().min(1),
    reproCommand: z.string().min(1).optional()
  })
  .strict();

export type RefuterOutput = z.infer<typeof RefuterOutputSchema>;
