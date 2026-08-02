const REDACTED = "[REDACTED]";
const SECRET_STARTERS = [
  { text: "authorization", kind: "assignment-wide" },
  { text: "set-cookie", kind: "assignment-wide" },
  { text: "cookie", kind: "assignment-wide" },
  { text: "x-api-key", kind: "assignment-narrow" },
  { text: "x-api_key", kind: "assignment-narrow" },
  { text: "x-apikey", kind: "assignment-narrow" },
  { text: "api-key", kind: "assignment-narrow" },
  { text: "api_key", kind: "assignment-narrow" },
  { text: "apikey", kind: "assignment-narrow" },
  { text: "credential", kind: "assignment-narrow" },
  { text: "password", kind: "assignment-narrow" },
  { text: "secret", kind: "assignment-narrow" },
  { text: "token", kind: "assignment-narrow" },
  { text: "bearer", kind: "bearer" },
  { text: "ghp_", kind: "github-token" },
  { text: "gho_", kind: "github-token" },
  { text: "ghu_", kind: "github-token" },
  { text: "ghs_", kind: "github-token" },
  { text: "ghr_", kind: "github-token" },
  { text: "sk-", kind: "openai-token" }
] as const;

type Starter = (typeof SECRET_STARTERS)[number];
type AssignmentKind = Extract<Starter["kind"], `assignment-${string}`>;
type ValueKind = AssignmentKind | "bearer" | "github-token" | "openai-token";
const STARTERS_BY_FIRST_CHARACTER = new Map<string, Starter[]>();
for (const starter of SECRET_STARTERS) {
  const firstCharacter = starter.text[0] ?? "";
  STARTERS_BY_FIRST_CHARACTER.set(firstCharacter, [
    ...(STARTERS_BY_FIRST_CHARACTER.get(firstCharacter) ?? []),
    starter
  ]);
}

const VALUE_ALLOWED: Record<ValueKind, (character: string) => boolean> = {
  "assignment-wide": (character) => !/["',}\]\r\n]/.test(character),
  "assignment-narrow": (character) => !/["'\\\s,}\]]/.test(character),
  bearer: (character) => /[A-Za-z0-9._~+/=-]/.test(character),
  "github-token": (character) => /[A-Za-z0-9_]/.test(character),
  "openai-token": (character) => /[A-Za-z0-9_-]/.test(character)
};

type RedactorMode =
  | "normal"
  | "assignment-key-quote"
  | "assignment-separator"
  | "assignment-value-quote"
  | "assignment-value"
  | "placeholder"
  | "bearer-space"
  | "token-candidate"
  | "suppress";

export interface SensitiveTextRedactor {
  write: (text: string) => string;
  end: () => string;
}

export function createSensitiveTextRedactor(): SensitiveTextRedactor {
  let mode: RedactorMode = "normal";
  let normalPending = "";
  let assignmentKind: AssignmentKind = "assignment-narrow";
  let valueKind: ValueKind = "assignment-narrow";
  let tokenCandidate = "";
  let tokenMinimumLength = 0;
  let placeholderCandidate = "";
  let lastEmittedCharacter = "";
  let ended = false;

  const process = (text: string, final: boolean): string => {
    let output = "";

    const emit = (value: string): void => {
      output += value;
      if (value) lastEmittedCharacter = value.at(-1) ?? lastEmittedCharacter;
    };

    const beginStarter = (starter: Starter, matchedText: string): void => {
      if (starter.kind === "assignment-wide" || starter.kind === "assignment-narrow") {
        emit(matchedText);
        assignmentKind = starter.kind;
        mode = "assignment-key-quote";
        return;
      }
      if (starter.kind === "bearer") {
        emit(matchedText);
        mode = "bearer-space";
        return;
      }
      valueKind = starter.kind;
      tokenCandidate = matchedText;
      tokenMinimumLength = matchedText.length + 20;
      mode = "token-candidate";
    };

    const processNormalCharacter = (character: string): void => {
      normalPending += character;
      while (normalPending) {
        const lowered = normalPending.toLowerCase();
        const candidates = (STARTERS_BY_FIRST_CHARACTER.get(lowered[0] ?? "") ?? [])
          .filter((starter) => starter.text.startsWith(lowered));
        if (candidates.length > 0) {
          const exact = candidates.find((starter) => starter.text === lowered);
          if (!exact) return;
          const requiresWordBoundary = exact.kind === "bearer"
            || exact.kind === "github-token"
            || exact.kind === "openai-token";
          if (requiresWordBoundary && /[A-Za-z0-9_]/.test(lastEmittedCharacter)) {
            emit(normalPending[0] ?? "");
            normalPending = normalPending.slice(1);
            continue;
          }
          const matchedText = normalPending;
          normalPending = "";
          beginStarter(exact, matchedText);
          return;
        }
        emit(normalPending[0] ?? "");
        normalPending = normalPending.slice(1);
      }
    };

    const suppressBufferedValue = (): void => {
      emit(REDACTED);
      mode = "suppress";
      for (const character of placeholderCandidate) {
        if (!VALUE_ALLOWED[valueKind](character)) {
          mode = "normal";
          processNormalCharacter(character);
        }
      }
      placeholderCandidate = "";
    };

    const processCharacter = (character: string): void => {
      if (mode === "normal") {
        processNormalCharacter(character);
        return;
      }

      if (mode === "assignment-key-quote") {
        if (character === '"' || character === "'") {
          emit(character);
          mode = "assignment-separator";
        } else if (/\s/.test(character)) {
          emit(character);
          mode = "assignment-separator";
        } else if (character === ":" || character === "=") {
          emit(character);
          mode = "assignment-value-quote";
        } else {
          mode = "normal";
          processNormalCharacter(character);
        }
        return;
      }

      if (mode === "assignment-separator") {
        if (/\s/.test(character)) {
          emit(character);
        } else if (character === ":" || character === "=") {
          emit(character);
          mode = "assignment-value-quote";
        } else {
          mode = "normal";
          processNormalCharacter(character);
        }
        return;
      }

      if (mode === "assignment-value-quote") {
        if (/\s/.test(character)) {
          emit(character);
        } else if (character === '"' || character === "'") {
          emit(character);
          mode = "assignment-value";
        } else {
          mode = "assignment-value";
          processCharacter(character);
        }
        return;
      }

      if (mode === "assignment-value") {
        valueKind = assignmentKind;
        if (!VALUE_ALLOWED[valueKind](character)) {
          mode = "normal";
          processNormalCharacter(character);
        } else if (character === "[") {
          placeholderCandidate = character;
          mode = "placeholder";
        } else {
          emit(REDACTED);
          mode = "suppress";
        }
        return;
      }

      if (mode === "placeholder") {
        placeholderCandidate += character;
        if (REDACTED.startsWith(placeholderCandidate)) {
          if (placeholderCandidate === REDACTED) {
            emit(REDACTED);
            placeholderCandidate = "";
            mode = "normal";
          }
        } else {
          suppressBufferedValue();
        }
        return;
      }

      if (mode === "bearer-space") {
        if (/\s/.test(character)) {
          emit(character);
        } else if (VALUE_ALLOWED.bearer(character)) {
          valueKind = "bearer";
          tokenCandidate = character;
          tokenMinimumLength = 12;
          mode = "token-candidate";
        } else {
          mode = "normal";
          processNormalCharacter(character);
        }
        return;
      }

      if (mode === "token-candidate") {
        if (VALUE_ALLOWED[valueKind](character)) {
          tokenCandidate += character;
          if (tokenCandidate.length >= tokenMinimumLength) {
            emit(REDACTED);
            tokenCandidate = "";
            mode = "suppress";
          }
        } else {
          const rejectedCandidate = tokenCandidate;
          tokenCandidate = "";
          mode = "normal";
          emit(rejectedCandidate[0] ?? "");
          for (const rejectedCharacter of rejectedCandidate.slice(1)) {
            processCharacter(rejectedCharacter);
          }
          processCharacter(character);
        }
        return;
      }

      if (VALUE_ALLOWED[valueKind](character)) return;
      mode = "normal";
      processNormalCharacter(character);
    };

    for (const character of text) processCharacter(character);

    if (final) {
      if (mode === "normal") emit(normalPending);
      if (mode === "token-candidate") emit(tokenCandidate);
      if (mode === "placeholder") suppressBufferedValue();
      normalPending = "";
      tokenCandidate = "";
    }
    return output;
  };

  return {
    write(text) {
      if (ended) throw new Error("Sensitive text redactor has already ended.");
      return process(text, false);
    },
    end() {
      if (ended) return "";
      ended = true;
      return process("", true);
    }
  };
}

export function redactSensitiveText(text: string): string {
  const redactor = createSensitiveTextRedactor();
  const output: string[] = [];
  for (let offset = 0; offset < text.length; offset += 4096) {
    output.push(redactor.write(text.slice(offset, offset + 4096)));
  }
  output.push(redactor.end());
  return output.join("");
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item)) as T;
  if (typeof value !== "object" || value === null) return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(?:(?:x-)?api[_-]?key|token|secret|password|credential|authorization|cookie|set-cookie)$/i.test(key)
        ? REDACTED
        : redactSensitiveValue(item)
    ])
  ) as T;
}
