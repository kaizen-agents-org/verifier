import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactSensitiveValue } from "../src/redaction.js";

describe("sensitive value redaction", () => {
  it("redacts quoted JSON field names without corrupting the document", () => {
    const source = '{"token":"stage5-secret","nested":{"password":"hunter2"}}';
    const redacted = redactSensitiveText(source);

    expect(JSON.parse(redacted)).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]" }
    });
  });

  it("redacts parsed string fields without a JSON serialization round trip", () => {
    const value = {
      scenario: 'config has password:"hunter2"',
      nested: [{ note: "token=stage5-secret" }]
    };

    expect(redactSensitiveValue(value)).toEqual({
      scenario: 'config has password:"[REDACTED]"',
      nested: [{ note: "token=[REDACTED]" }]
    });
    expect(redactSensitiveValue(redactSensitiveValue(value))).toEqual(
      redactSensitiveValue(value)
    );
  });
});
