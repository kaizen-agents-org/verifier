const REDACTED = "[REDACTED]";
const SECRET_VALUE_PATTERNS = [
  /((?:authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^"',}\]\r\n]+)/gi,
  /((?:(?:x-)?api[_-]?key|token|secret|password|credential)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^"'\\\s,}\]]+)/gi,
  /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g
];

export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: string[]) => {
      const match = args[0];
      const prefix = args[1];
      if (!prefix || prefix === match) return REDACTED;
      return `${prefix}${REDACTED}`;
    });
  }
  return redacted;
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
