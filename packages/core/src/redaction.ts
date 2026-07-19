const REDACTED = "[REDACTED]";
const SECRET_VALUE_PATTERNS = [
  /((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?)([^"'\s]+)/gi,
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
