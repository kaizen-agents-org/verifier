import { describe, expect, it, vi } from "vitest";
import { createSemanticBatchItems, submitSemanticEvalBatch } from "../src/eval/batch.js";

describe("semantic eval batch seam", () => {
  const inputs = [
    {
      caseId: "sb-001",
      input: { diff: "diff", context: "code", claims: [] }
    }
  ];

  it("separates full-corpus request construction from API submission", async () => {
    expect(createSemanticBatchItems(inputs)[0]).toMatchObject({
      customId: "sb-001",
      request: { model: "claude-opus-4-8", system: [{ cache_control: { type: "ephemeral" } }] }
    });

    const submitter = vi.fn().mockResolvedValue({ id: "batch-1", status: "queued" });
    await expect(submitSemanticEvalBatch(inputs, submitter)).resolves.toEqual({
      id: "batch-1",
      status: "queued"
    });
    expect(submitter).toHaveBeenCalledOnce();
  });
});
