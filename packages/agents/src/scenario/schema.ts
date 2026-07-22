import { z } from "zod/v4";

const RequestExpectationSchema = z
  .object({
    status: z.number().int().optional(),
    statusAnyOf: z.array(z.number().int()).optional(),
    jsonSchema: z.json().optional(),
    bodyIncludes: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .strict()
  .refine(
    ({ status, statusAnyOf }) => status === undefined || statusAnyOf === undefined,
    { message: "Request expectation cannot specify both status and statusAnyOf." }
  )
  .refine(
    ({ statusAnyOf }) => statusAnyOf === undefined || statusAnyOf.length > 0,
    { message: "Request expectation statusAnyOf must contain at least one status." }
  );

export const StepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("navigate"), url: z.string().min(1) }).strict(),
  z.object({ op: z.literal("click"), target: z.string().min(1) }).strict(),
  z.object({ op: z.literal("type"), target: z.string().min(1), text: z.string() }).strict(),
  z.object({ op: z.literal("key"), keys: z.string().min(1) }).strict(),
  z.object({ op: z.literal("exec"), command: z.string().min(1), stdin: z.string().optional() }).strict(),
  z
    .object({
      op: z.literal("request"),
      method: z.string().min(1),
      path: z.string().startsWith("/"),
      body: z.json().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      expect: RequestExpectationSchema.optional()
    })
    .strict(),
  z.object({ op: z.literal("wait"), forMs: z.number().int().nonnegative().optional(), until: z.string().optional() }).strict(),
  z.object({ op: z.literal("assert-screen"), naturalLanguage: z.string().min(1) }).strict()
]);

export const ScenarioSchema = z
  .object({
    id: z.string().max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    description: z.string().min(1),
    claimIds: z.array(z.string().min(1)).min(1),
    failCategory: z
      .enum(["security", "data-loss", "crash", "regression", "logic", "perf"])
      .optional(),
    steps: z.array(StepSchema).min(1).max(20)
  })
  .strict();

export const ScenarioGenerationSchema = z
  .object({ scenarios: z.array(ScenarioSchema).max(20) })
  .strict();

export type ScenarioGeneration = z.infer<typeof ScenarioGenerationSchema>;
