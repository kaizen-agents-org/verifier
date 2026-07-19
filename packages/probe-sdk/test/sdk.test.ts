import { describe, expect, it } from "vitest";
import { LaunchError, UnsupportedStepError } from "../src/index.js";

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
});
