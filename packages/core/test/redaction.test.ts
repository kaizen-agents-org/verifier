import { describe, expect, it } from "vitest";
import {
  createSensitiveTextRedactor,
  redactSensitiveText,
  redactSensitiveValue
} from "../src/redaction.js";

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

  it("redacts secret-bearing header fields by key", () => {
    expect(redactSensitiveValue({
      authorization: "Basic dXNlcjpwYXNz",
      "set-cookie": "session=private",
      "x-api-key": "private-api-key",
      "content-type": "application/json"
    })).toEqual({
      authorization: "[REDACTED]",
      "set-cookie": "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "content-type": "application/json"
    });
  });

  it("redacts complete secret-bearing header values in text", () => {
    const source = [
      "authorization: Bearer header.payload.signature",
      '"authorization":"Basic dXNlcjpwYXNz"',
      "cookie=session=private; theme=dark",
      '"set-cookie":"session=private; HttpOnly"',
      "content-type: application/json"
    ].join("\n");

    expect(redactSensitiveText(source)).toBe([
      "authorization: [REDACTED]",
      '"authorization":"[REDACTED]"',
      "cookie=[REDACTED]",
      '"set-cookie":"[REDACTED]"',
      "content-type: application/json"
    ].join("\n"));
  });

  it("preserves secret state across arbitrary write boundaries", () => {
    const redactor = createSensitiveTextRedactor();
    const chunks = ["before tok", "en", "  =  ", "split-", "secret", " after"];
    const output = chunks.map((chunk) => redactor.write(chunk)).join("") + redactor.end();

    expect(output).toBe("before token  =  [REDACTED] after");
  });

  it("uses constant secret state for values longer than the capture limit", () => {
    const redactor = createSensitiveTextRedactor();
    const outputs = [redactor.write("token=")];
    for (let index = 0; index < 128; index += 1) {
      outputs.push(redactor.write("s".repeat(1024)));
    }
    outputs.push(redactor.write("\nvisible"), redactor.end());

    expect(outputs.join("")).toBe("token=[REDACTED]\nvisible");
  });

  it.each([
    'prefix token = "split-secret" suffix',
    "authorization: Bearer header.payload.signature\nvisible",
    "Bearer abcdefghijklmnop visible",
    `ghp_${"a".repeat(24)} visible`,
    `sk-${"b".repeat(24)} visible`
  ])("matches one-shot redaction at every chunk boundary for %s", (source) => {
    const expected = redactSensitiveText(source);

    for (let split = 0; split <= source.length; split += 1) {
      const redactor = createSensitiveTextRedactor();
      const actual = redactor.write(source.slice(0, split))
        + redactor.write(source.slice(split))
        + redactor.end();
      expect(actual).toBe(expected);
    }
  });
});
