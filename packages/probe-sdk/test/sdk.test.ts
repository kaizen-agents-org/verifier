import { describe, expect, it } from "vitest";
import { LaunchError, UnsupportedStepError, validateRequestExpectation } from "../src/index.js";

describe("probe SDK errors", () => {
  it("preserves launch retry metadata", () => {
    const cause = new Error("bind failed");
    const error = new LaunchError("Could not launch", { cause, retryable: true });
    expect(error).toMatchObject({ name: "LaunchError", cause, retryable: true });
  });

  it("preserves unsupported step metadata", () => {
    const step = { op: "click", target: "button" } as const;
    const error = new UnsupportedStepError(step, "CLI cannot click");
    expect(error).toMatchObject({ name: "UnsupportedStepError", step, retryable: false });
  });

  it("validates mutually exclusive and non-empty request status expectations", () => {
    expect(validateRequestExpectation({ status: 200 })).toBeUndefined();
    expect(validateRequestExpectation({ statusAnyOf: [200, 204] })).toBeUndefined();
    expect(validateRequestExpectation({ status: 200, statusAnyOf: [200] })).toContain(
      "both status and statusAnyOf"
    );
    expect(validateRequestExpectation({ statusAnyOf: [] })).toContain("at least one status");
  });
});
