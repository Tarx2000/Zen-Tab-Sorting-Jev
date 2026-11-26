const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 60;

const SECRET_EXACT_KEYS = new Set([
  "authorization",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "key",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
]);

const SECRET_SUBSTRING_KEYS = [
  "apikey",
  "api_key",
  "api-key",
  "x-goog-api-key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "token",
  "secret",
  "password",
  "cookie",
];

// Telemetry / usage keys that contain "token" but are numeric counts, never credentials.
const ALLOWED_TOKEN_KEYS = new Set([
  "max_tokens",
  "maxtokens",
  "prompt_tokens",
  "prompttokens",
  "completion_tokens",
  "completiontokens",
  "total_tokens",
  "totaltokens",
  "tokencount",
  "token_count",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "reasoning_tokens",
]);

const isSecretKey = (key) => {
  const lower = String(key || "").toLowerCase();
  if (!lower || ALLOWED_TOKEN_KEYS.has(lower)) return false;
  if (SECRET_EXACT_KEYS.has(lower)) return true;
  return SECRET_SUBSTRING_KEYS.some((needle) => lower.includes(needle));
};

const truncateString = (value) =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;

export const redactSecretString = (value) => {
  const redacted = String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{4,}/gi, "Basic [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, "[jwt-redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]+/g, "sk-[redacted]")
    .replace(/\bAIza[A-Za-z0-9._-]+/g, "AIza[redacted]")
    .replace(/\bgsk_[A-Za-z0-9._-]+/g, "gsk_[redacted]")
    .replace(/\bxai-[A-Za-z0-9._-]+/g, "xai-[redacted]")
    .replace(/\bpplx-[A-Za-z0-9._-]+/g, "pplx-[redacted]")
    .replace(/\bghp_[A-Za-z0-9._-]+/g, "ghp_[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9._-]+/g, "github_pat_[redacted]")
    .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&#\s]+/gi, "$1[redacted]");
  return truncateString(redacted);
};

const redactValue = (value, depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string") return redactSecretString(value);
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return String(value);
  if (type === "function" || type === "symbol") return `[${type}]`;

  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";

  seen.add(value);
  try {
    if (value instanceof Error) {
      const serialized = {
        name: String(value.name || "Error"),
        message: redactSecretString(value.message || ""),
      };
      if (value.stack) serialized.stack = redactSecretString(value.stack);
      if (value.cause !== undefined) serialized.cause = redactValue(value.cause, depth + 1, seen);
      return serialized;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }

    if (Array.isArray(value)) {
      const sliced = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_LENGTH) {
        sliced.push(`... (+${value.length - MAX_ARRAY_LENGTH} more)`);
      }
      return sliced;
    }

    const entries = Object.entries(value);
    const out = {};
    const limit = Math.min(entries.length, MAX_OBJECT_KEYS);
    for (let i = 0; i < limit; i++) {
      const [key, entry] = entries[i];
      out[key] = isSecretKey(key) ? "[redacted]" : redactValue(entry, depth + 1, seen);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return out;
  } finally {
    seen.delete(value);
  }
};

export const createSafeLogEvent = (event) => redactValue(event, 0, new WeakSet());
