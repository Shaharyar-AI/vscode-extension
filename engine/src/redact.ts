/**
 * Redaction. Security-critical, and deliberately in the engine rather than the
 * prompt: this runs over every string that leaves the machine, whatever
 * produced it.
 *
 * The point is not to catch every secret ever written — that is impossible —
 * but to guarantee that a report never carries a credential the model happened
 * to quote back, and to fail toward over-redaction when unsure.
 */

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g },
  { name: "aws-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-key", re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: "assignment",
    // Keep the key name, drop the value: "apiKey: [REDACTED]" still reads.
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd|credential)\b(\s*[:=]\s*)(['"]?)[^\s'",;}]{6,}\3/gi,
  },
  { name: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi },
  { name: "long-hex", re: /\b[0-9a-fA-F]{32,}\b/g },
  { name: "long-base64", re: /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g },
];

export const REDACTED = "[REDACTED]";

export interface RedactionResult<T> {
  value: T;
  /** Which pattern names fired, for the log. Never the matched values. */
  hits: string[];
}

/** Redact one string. */
export function redactString(input: string): { text: string; hits: string[] } {
  if (!input) return { text: input, hits: [] };
  let text = input;
  const hits: string[] = [];

  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    hits.push(name);
    text =
      name === "assignment"
        ? text.replace(re, (_m, key, sep) => `${key}${sep}${REDACTED}`)
        : name === "url-credentials"
          ? text.replace(re, (_m, scheme) => `${scheme}${REDACTED}@`)
          : text.replace(re, REDACTED);
  }
  return { text, hits };
}

/**
 * Redact every string in a structure, in place of the original.
 *
 * Keys are left alone — a key called `password` is information about shape, not
 * a secret, and blanking it would make reports unreadable.
 */
export function redactDeep<T>(input: T): RedactionResult<T> {
  const hits = new Set<string>();

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const { text, hits: found } = redactString(value);
      for (const h of found) hits.add(h);
      return text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };

  return { value: walk(input) as T, hits: [...hits] };
}
