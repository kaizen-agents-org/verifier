import type { CorrectnessReviewInput, CorrectnessReviewRequest } from "../correctness/client.js";
import { createCorrectnessReviewRequest } from "../correctness/client.js";

export interface SemanticBatchItem {
  customId: string;
  request: CorrectnessReviewRequest;
}

export interface SemanticBatchSubmission {
  id: string;
  status: string;
}

export type SemanticBatchSubmitter = (
  items: SemanticBatchItem[]
) => Promise<SemanticBatchSubmission>;

export function createSemanticBatchItems(
  inputs: Array<{ caseId: string; input: CorrectnessReviewInput }>
): SemanticBatchItem[] {
  return inputs.map(({ caseId, input }) => ({
    customId: caseId,
    request: createCorrectnessReviewRequest(input)
  }));
}

export async function submitSemanticEvalBatch(
  inputs: Array<{ caseId: string; input: CorrectnessReviewInput }>,
  submitter: SemanticBatchSubmitter
): Promise<SemanticBatchSubmission> {
  return submitter(createSemanticBatchItems(inputs));
}
