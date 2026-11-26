// Zen Tab Sorting — typed provider HTTP errors, classification, Retry-After
// parsing, and bounded transient retry helper with exponential backoff + jitter.

export const ERROR_CATEGORIES = Object.freeze({
  AUTH: "auth",
  QUOTA: "quota",
  RATE_LIMIT: "rate_limit",
  TRANSIENT: "transient",
  BAD_REQUEST: "bad_request",
  NOT_FOUND: "not_found",
  NETWORK: "network",
  TIMEOUT: "timeout",
  ABORT: "abort",
});

export const NON_RETRYABLE_CATEGORIES = Object.freeze(new Set([
  ERROR_CATEGORIES.AUTH,
  ERROR_CATEGORIES.QUOTA,
  ERROR_CATEGORIES.NOT_FOUND,
  ERROR_CATEGORIES.BAD_REQUEST,
  ERROR_CATEGORIES.ABORT,
]));

export const RETRYABLE_CATEGORIES = Object.freeze(new Set([
  ERROR_CATEGORIES.RATE_LIMIT,
  ERROR_CATEGORIES.TRANSIENT,
  ERROR_CATEGORIES.NETWORK,
  ERROR_CATEGORIES.TIMEOUT,
]));

export const FATAL_CATEGORIES = Object.freeze(new Set([
  ERROR_CATEGORIES.AUTH,
  ERROR_CATEGORIES.QUOTA,
  ERROR_CATEGORIES.NOT_FOUND,
  ERROR_CATEGORIES.ABORT,
]));

const QUOTA_PATTERN =
  /insufficient[_\s-]?quota|exceeded.*(?:quota|limit|budget)|subscription\s+sharing\s+usage\s+limit|usage\s+limit\s+reached|billing[_\s-]?hard[_\s-]?limit|credit\s+balance\s+is\s+too\s+low|out\s+of\s+credits|resource_exhausted|quota\s+exceeded/i;

const TIMEOUT_PATTERN = /\btimeout\b|timed\s*out|time\s+budget\s+exhausted/i;

export class ProviderHttpError extends Error {
  constructor({
    status = 0,
    body = "",
    retryAfterMs = null,
    category = null,
    provider = "",
    message = "",
    cause = undefined,
  } = {}) {
    const resolvedCategory = category || classifyProviderError(status, body, cause);
    const defaultMessage = status > 0
      ? `HTTP ${status}${provider ? ` (${provider})` : ""}: ${String(body || "").slice(0, 200)}`
      : (cause?.message || `Provider ${resolvedCategory} error${provider ? ` (${provider})` : ""}`);
    super(message || defaultMessage);
    this.name = "ProviderHttpError";
    this.status = Number.isFinite(status) ? status : 0;
    this.body = String(body ?? "");
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.round(retryAfterMs) : null;
    this.category = resolvedCategory;
    this.provider = String(provider || "");
    this.retryable = RETRYABLE_CATEGORIES.has(resolvedCategory);
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Parse an HTTP `Retry-After` header (either delay-seconds or HTTP-date) into
 * milliseconds. Returns `null` if missing or invalid.
 */
export const parseRetryAfterMs = (headerValue, nowMs = Date.now()) => {
  if (headerValue == null) return null;
  const raw = String(headerValue).trim();
  if (!raw) return null;

  // Delay-seconds (e.g., "2", "1.5", "0")
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number.parseFloat(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    return null;
  }

  // HTTP-date (IMF-fixdate / RFC 850 / asctime)
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.round(parsed - nowMs));
  }
  return null;
};

/**
 * Classify a provider failure into one of the 9 typed categories:
 * `"auth"`, `"quota"`, `"rate_limit"`, `"transient"`, `"bad_request"`,
 * `"not_found"`, `"network"`, `"timeout"`, `"abort"`.
 */
export const classifyProviderError = (status, body = "", err = null) => {
  if (err && typeof err === "object" && typeof err.category === "string" && Object.values(ERROR_CATEGORIES).includes(err.category)) {
    return err.category;
  }

  const numericStatus = Number.isFinite(status)
    ? status
    : Number.isFinite(err?.status)
      ? err.status
      : 0;
  const text = `${String(body || "")} ${String(err?.body || "")} ${String(err?.message || "")}`.trim();

  if (err?.requiresSignIn || err?.code === "chatgpt_sign_in_required") {
    return ERROR_CATEGORIES.AUTH;
  }

  if (numericStatus > 0) {
    if (numericStatus === 401) return ERROR_CATEGORIES.AUTH;
    if (numericStatus === 402) return ERROR_CATEGORIES.QUOTA;
    if (numericStatus === 403) {
      return QUOTA_PATTERN.test(text) ? ERROR_CATEGORIES.QUOTA : ERROR_CATEGORIES.AUTH;
    }
    if (numericStatus === 404) return ERROR_CATEGORIES.NOT_FOUND;
    if (numericStatus === 408) return ERROR_CATEGORIES.TIMEOUT;
    if (numericStatus === 429) {
      return QUOTA_PATTERN.test(text) ? ERROR_CATEGORIES.QUOTA : ERROR_CATEGORIES.RATE_LIMIT;
    }
    if (numericStatus === 400 || numericStatus === 422) {
      return QUOTA_PATTERN.test(text) ? ERROR_CATEGORIES.QUOTA : ERROR_CATEGORIES.BAD_REQUEST;
    }
    if (numericStatus >= 500 && numericStatus <= 599) {
      return ERROR_CATEGORIES.TRANSIENT;
    }
    if (numericStatus >= 400 && numericStatus < 500) {
      return ERROR_CATEGORIES.BAD_REQUEST;
    }
  }

  if (err?.code === "timeout" || err?.name === "TimeoutError") {
    return ERROR_CATEGORIES.TIMEOUT;
  }
  if (err?.code === "abort" || err?.name === "AbortError") {
    return TIMEOUT_PATTERN.test(text) ? ERROR_CATEGORIES.TIMEOUT : ERROR_CATEGORIES.ABORT;
  }
  if (TIMEOUT_PATTERN.test(text)) {
    return ERROR_CATEGORIES.TIMEOUT;
  }
  if (QUOTA_PATTERN.test(text)) {
    return ERROR_CATEGORIES.QUOTA;
  }
  return ERROR_CATEGORIES.NETWORK;
};

export const isRetryableError = (err) => {
  if (!err) return false;
  if (err.requiresSignIn) return false;
  const category = classifyProviderError(err.status, err.body, err);
  return RETRYABLE_CATEGORIES.has(category);
};

export const isFatalProviderError = (err) => {
  if (!err) return false;
  if (err.requiresSignIn || err.reason === "consent_required" || err.code === "consent_required") {
    return true;
  }
  const category = classifyProviderError(err.status, err.body, err);
  return FATAL_CATEGORIES.has(category);
};

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderHttpError({ category: ERROR_CATEGORIES.ABORT, message: "Request aborted" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderHttpError({ category: ERROR_CATEGORIES.ABORT, message: "Request aborted" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

/**
 * Execute an async provider operation with bounded retries on transient errors
 * (`rate_limit`, `transient`, `network`, `timeout`). Immediately rethrows on
 * `auth`, `quota`, `not_found`, `bad_request`, and `abort` (0 retries).
 * Honors `Retry-After` headers, capped exponential backoff + jitter, `signal`,
 * and `deadlineAt`.
 */
export const withTransientRetry = async (
  fn,
  {
    signal = null,
    deadlineAt = null,
    maxAttempts = 3,
    baseDelayMs = 400,
    maxDelayMs = 8000,
    minBudgetForRetryMs = 300,
    onRetry = null,
    sleepImpl = defaultSleep,
    randomImpl = Math.random,
  } = {},
) => {
  const attempts = Number.isFinite(maxAttempts) && maxAttempts >= 1 ? Math.floor(maxAttempts) : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      throw new ProviderHttpError({ category: ERROR_CATEGORIES.ABORT, message: "Request aborted" });
    }
    try {
      const remainingMs = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now()) : null;
      return await fn({ attempt, signal, remainingMs });
    } catch (err) {
      const category = classifyProviderError(err?.status, err?.body, err);
      if (
        attempt >= attempts ||
        signal?.aborted ||
        err?.requiresSignIn ||
        NON_RETRYABLE_CATEGORIES.has(category)
      ) {
        throw err;
      }

      let delayMs;
      if (Number.isFinite(err?.retryAfterMs) && err.retryAfterMs >= 0) {
        delayMs = Math.min(err.retryAfterMs, maxDelayMs);
      } else {
        const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
        const jitterFactor = 0.75 + (Number(randomImpl()) * 0.5);
        delayMs = Math.min(maxDelayMs, Math.round(exp * jitterFactor));
      }

      if (Number.isFinite(deadlineAt)) {
        const remaining = deadlineAt - Date.now();
        // If Retry-After alone exceeds our remaining time budget, stop immediately
        // instead of stalling the user until timeout.
        if (Number.isFinite(err?.retryAfterMs) && err.retryAfterMs + minBudgetForRetryMs > remaining) {
          throw err;
        }
        if (remaining - delayMs < minBudgetForRetryMs) {
          throw err;
        }
      }

      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error: err, category });
      await sleepImpl(delayMs, signal);
    }
  }
  return undefined;
};
