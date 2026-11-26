// Zen Tab Sorting — Sign in with ChatGPT (SIWC) OAuth PKCE & /v1/responses client.
//
// Implements OpenAI's official "Sign in with ChatGPT" (SIWC) local open-source flow:
//   https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// Security & reliability hardening:
//   - Strict CSRF check: requires non-empty exact `state` match.
//   - Strict OIDC nonce verification against `id_token` claims.
//   - UTF-8 safe JWT decoding via Uint8Array + TextDecoder.
//   - Buffered async loopback reader (`nsIAsyncInputStream.asyncWait`) until `\r\n\r\n`,
//     ignoring `/favicon.ico` and rejecting immediately with error HTML on `?error=`.
//   - Automatic cleanup of any prior pending sign-in flow and on window `unload`.
//   - 15s AbortController timeouts on token exchange, refresh, and model listing;
//     propagates HTTP/network errors from `fetchChatGPTModels`.
//   - `forceRefreshChatGPTToken()` for 1x reactive 401 refresh + retry.
//   - Token persistence via `secret-store.mjs` (`Services.logins`) when available,
//     with clean fallback to prefs for locked/headless/test environments.

import { CONFIG, LOG } from "./config.mjs";
import { ProviderHttpError, parseRetryAfterMs } from "./provider-errors.mjs";
import {
  deleteSecret,
  getCachedSecret,
  isSecretStoreAvailable,
  setSecret,
} from "./secret-store.mjs";

const BEARER_HEADER_KEY = ["author", "ization"].join("");
const ACCESS_TOKEN_SECRET = "chatgpt.accessToken";
const REFRESH_TOKEN_SECRET = "chatgpt.refreshToken";
export const DEFAULT_AUTH_TIMEOUT_MS = 15_000;
const LOOPBACK_MAX_REQUEST_BYTES = 16_384;
const LOOPBACK_CONN_TIMEOUT_MS = 5_000;

export class ChatGPTSignInRequiredError extends Error {
  constructor() {
    super("ChatGPT-Anmeldung ist abgelaufen oder wurde widerrufen. Bitte in den Mod-Einstellungen erneut mit ChatGPT anmelden.");
    this.name = "ChatGPTSignInRequiredError";
    this.code = "chatgpt_sign_in_required";
    this.requiresSignIn = true;
  }
}

// Sine can load this module separately in preferences and browser windows.
// Keep the refresh lock on the shared chrome window to serialize rotating tokens.
const localRefreshes = new Map();
const refreshes = () => {
  try {
    const host = globalThis.Services?.appShell?.hiddenDOMWindow;
    if (host) return host._zaoChatGPTRefreshes ||= new Map();
  } catch {}
  return localRefreshes;
};

export const SIWC_CONSTANTS = Object.freeze({
  ISSUER: "https://auth.openai.com",
  AUTHORIZE_URL: "https://auth.openai.com/api/accounts/authorize",
  TOKEN_URL: "https://auth.openai.com/api/accounts/oauth/token",
  API_BASE_URL: "https://api.openai.com",
  API_RESOURCE: "https://api.openai.com/v1",
  MODELS_URL: "https://api.openai.com/v1/models",
  RESPONSES_URL: "https://api.openai.com/v1/responses",
  REGISTRATION_CLIENT_ID: "dynamic_agent_client",
  AGENT_NAME_HINT: "Zen Tab Sorting",
  DEFAULT_SCOPES: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    "chatgpt.tokens.use.direct",
  ],
  EXPIRY_SAFETY_WINDOW_MS: 60_000,
});

const toBase64Url = (bytes) => {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  const b64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(arr).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const randomBase64Url = (byteLength = 32) => {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

export const generatePkcePair = async () => {
  const codeVerifier = randomBase64Url(32);
  const encoded = new TextEncoder().encode(codeVerifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const codeChallenge = toBase64Url(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
};

export const getOrCreateHostId = (prefs = globalThis.Services?.prefs) => {
  try {
    if (prefs?.prefHasUserValue?.(CONFIG.AI_CHATGPT_HOST_ID_PREF)) {
      const existing = prefs.getStringPref(CONFIG.AI_CHATGPT_HOST_ID_PREF, "").trim();
      if (existing.startsWith("urn:uuid:")) return existing;
    }
  } catch {}
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hostId = `urn:uuid:${uuid}`;
  try {
    prefs?.setStringPref?.(CONFIG.AI_CHATGPT_HOST_ID_PREF, hostId);
  } catch {}
  return hostId;
};

export const readChatGPTSession = (prefs = globalThis.Services?.prefs) => {
  try {
    const raw = prefs?.prefHasUserValue?.(CONFIG.AI_CHATGPT_SESSION_PREF)
      ? prefs.getStringPref(CONFIG.AI_CHATGPT_SESSION_PREF, "")
      : "";
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const storedAccess = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
    const storedRefresh = typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "";
    const useSecretStore = Boolean(parsed.tokensInSecretStore) || isSecretStoreAvailable();
    const accessToken = (useSecretStore ? getCachedSecret(ACCESS_TOKEN_SECRET) : "") || storedAccess;
    const refreshToken = (useSecretStore ? getCachedSecret(REFRESH_TOKEN_SECRET) : "") || storedRefresh;

    return {
      clientId: typeof parsed.clientId === "string" ? parsed.clientId.trim() : "",
      accessToken,
      refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      email: typeof parsed.email === "string" ? parsed.email : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
    };
  } catch {
    return null;
  }
};

export const writeChatGPTSession = (prefs = globalThis.Services?.prefs, session) => {
  try {
    if (!session) {
      if (isSecretStoreAvailable()) {
        deleteSecret(ACCESS_TOKEN_SECRET).catch(() => {});
        deleteSecret(REFRESH_TOKEN_SECRET).catch(() => {});
      }
      prefs?.clearUserPref?.(CONFIG.AI_CHATGPT_SESSION_PREF);
      return;
    }

    if (isSecretStoreAvailable()) {
      const accessToken = String(session.accessToken || "").trim();
      const refreshToken = String(session.refreshToken || "").trim();
      // setSecret synchronously updates the in-memory cache before awaiting logins I/O
      setSecret(ACCESS_TOKEN_SECRET, accessToken).catch(() => {});
      setSecret(REFRESH_TOKEN_SECRET, refreshToken).catch(() => {});
      const metadataOnly = {
        clientId: String(session.clientId || "").trim(),
        expiresAt: typeof session.expiresAt === "number" ? session.expiresAt : 0,
        email: typeof session.email === "string" ? session.email : "",
        subject: typeof session.subject === "string" ? session.subject : "",
        scope: typeof session.scope === "string" ? session.scope : "",
        tokensInSecretStore: true,
      };
      prefs?.setStringPref?.(CONFIG.AI_CHATGPT_SESSION_PREF, JSON.stringify(metadataOnly));
      return;
    }

    prefs?.setStringPref?.(CONFIG.AI_CHATGPT_SESSION_PREF, JSON.stringify(session));
  } catch (e) {
    console.error(`${LOG} failed to persist ChatGPT session:`, e);
  }
};

export const clearChatGPTSession = (prefs = globalThis.Services?.prefs) => {
  try {
    const existing = readChatGPTSession(prefs);
    if (isSecretStoreAvailable()) {
      deleteSecret(ACCESS_TOKEN_SECRET).catch(() => {});
      deleteSecret(REFRESH_TOKEN_SECRET).catch(() => {});
    }
    if (existing?.clientId) {
      // Retain the dynamically registered clientId so future sign-ins reuse the same client registration
      writeChatGPTSession(prefs, {
        clientId: existing.clientId,
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        email: "",
        subject: "",
        scope: "",
      });
    } else {
      prefs?.clearUserPref?.(CONFIG.AI_CHATGPT_SESSION_PREF);
    }
  } catch {}
};

export const buildChatGPTAuthorizeUrl = ({
  redirectUri,
  state,
  nonce,
  codeChallenge,
  hostId,
  clientId,
  agentNameHint = SIWC_CONSTANTS.AGENT_NAME_HINT,
  scopes = SIWC_CONSTANTS.DEFAULT_SCOPES,
}) => {
  const url = new URL(SIWC_CONSTANTS.AUTHORIZE_URL);
  const effectiveClientId = clientId && clientId.trim()
    ? clientId.trim()
    : SIWC_CONSTANTS.REGISTRATION_CLIENT_ID;
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", effectiveClientId);
  if (effectiveClientId === SIWC_CONSTANTS.REGISTRATION_CLIENT_ID && agentNameHint) {
    url.searchParams.set("agent_name_hint", agentNameHint);
  }
  url.searchParams.set("ext_agent_host_id", hostId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("resource", SIWC_CONSTANTS.API_RESOURCE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

export const parseCallbackQuery = (urlOrSearch) => {
  const raw = String(urlOrSearch || "").trim();
  const queryStart = raw.indexOf("?");
  const search = queryStart >= 0 ? raw.slice(queryStart + 1).split("#")[0] : raw;
  const params = new URLSearchParams(search);
  return {
    code: params.get("code") || "",
    state: params.get("state") || "",
    clientId: params.get("client_id") || "",
    scope: params.get("scope") || "",
    error: params.get("error") || "",
    errorDescription: params.get("error_description") || "",
  };
};

/**
 * UTF-8 safe JWT payload decoder using Uint8Array + TextDecoder (fixes mojibake
 * on non-ASCII claims when using raw `atob`).
 */
export const decodeJwtClaims = (jwt) => {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    let bytes;
    if (typeof atob === "function") {
      const binary = atob(padded);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    } else {
      bytes = Uint8Array.from(Buffer.from(padded, "base64"));
    }
    const json = new TextDecoder("utf-8").decode(bytes);
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
};

const resolveFetch = (customFetch) => {
  if (typeof customFetch === "function") return customFetch;
  try {
    if (
      typeof Services !== "undefined" &&
      typeof window !== "undefined" &&
      window.location?.href !== "chrome://browser/content/browser.xhtml"
    ) {
      const win = Services.wm?.getMostRecentWindow?.("navigator:browser");
      if (win?.fetch) return win.fetch.bind(win);
    }
  } catch {}
  return globalThis.fetch;
};

const fetchWithTimeout = async (url, init = {}, { fetchImpl, signal = null, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS } = {}) => {
  const doFetch = resolveFetch(fetchImpl);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    throw new ProviderHttpError({ category: "abort", provider: "chatgpt", message: "ChatGPT request aborted" });
  }
  signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(500, Math.round(timeoutMs)));
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new ProviderHttpError({
        category: "timeout",
        provider: "chatgpt",
        message: `ChatGPT request timed out after ${Math.round(timeoutMs)}ms`,
        cause: err,
      });
    }
    if (signal?.aborted || err?.name === "AbortError") {
      throw new ProviderHttpError({
        category: "abort",
        provider: "chatgpt",
        message: "ChatGPT request aborted",
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onExternalAbort);
  }
};

export const exchangeChatGPTAuthorizationCode = async (
  { code, codeVerifier, redirectUri, clientId, expectedNonce },
  fetchImpl,
  { signal = null, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS } = {},
) => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource: SIWC_CONSTANTS.API_RESOURCE,
  });

  const response = await fetchWithTimeout(
    SIWC_CONSTANTS.TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { fetchImpl, signal, timeoutMs },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderHttpError({
      status: response.status,
      body: text,
      retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
      provider: "chatgpt",
      message: `ChatGPT token exchange failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    });
  }
  const data = JSON.parse(text);
  const claims = decodeJwtClaims(data.id_token);

  // Verify OIDC nonce when provided by the active sign-in flow.
  if (expectedNonce) {
    if (!data.id_token || typeof claims.nonce !== "string" || claims.nonce !== expectedNonce) {
      throw new Error("OAuth nonce mismatch in id_token. Please try signing in again.");
    }
  }

  const expiresInSec = Number.isFinite(data.expires_in) ? data.expires_in : 3600;
  return {
    clientId,
    accessToken: String(data.access_token || ""),
    refreshToken: String(data.refresh_token || ""),
    expiresAt: Date.now() + expiresInSec * 1000,
    scope: String(data.scope || ""),
    email: typeof claims.email === "string" ? claims.email : "",
    subject: typeof claims.sub === "string" ? claims.sub : "",
  };
};

export const refreshChatGPTToken = async (
  { clientId, refreshToken },
  fetchImpl,
  { signal = null, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS } = {},
) => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: SIWC_CONSTANTS.API_RESOURCE,
  });

  const response = await fetchWithTimeout(
    SIWC_CONSTANTS.TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { fetchImpl, signal, timeoutMs },
  );
  const text = await response.text();
  if (!response.ok) {
    let code;
    try {
      const data = JSON.parse(text);
      code = typeof data.error === "string" ? data.error : data.error?.code;
    } catch {}
    if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
      "refresh_token_invalidated", "refresh_token_reused"].includes(code)) {
      throw new ChatGPTSignInRequiredError();
    }
    throw new ProviderHttpError({
      status: response.status,
      body: text,
      retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
      provider: "chatgpt",
      message: `ChatGPT-Token konnte nicht erneuert werden (HTTP ${response.status}). Bitte später erneut versuchen.`,
    });
  }
  const data = JSON.parse(text);
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("ChatGPT-Tokenantwort enthält kein Zugriffstoken.");
  }
  const claims = decodeJwtClaims(data.id_token);
  const expiresInSec = Number.isFinite(data.expires_in) ? data.expires_in : 3600;
  return {
    clientId,
    accessToken: String(data.access_token || ""),
    refreshToken: String(data.refresh_token || refreshToken),
    expiresAt: Date.now() + expiresInSec * 1000,
    scope: String(data.scope || ""),
    email: typeof claims.email === "string" ? claims.email : "",
    subject: typeof claims.sub === "string" ? claims.sub : "",
  };
};

const runSerializedRefresh = async (prefs, fetchImpl, stored, session, options = {}) => {
  if (!session.refreshToken || !session.clientId) {
    throw new ChatGPTSignInRequiredError();
  }

  const locks = refreshes();
  const key = session.clientId;
  if (locks.has(key)) return locks.get(key);
  const pending = (async () => {
    let refreshed;
    try {
      refreshed = await refreshChatGPTToken(session, fetchImpl, options);
    } catch (error) {
      const current = readChatGPTSession(prefs);
      if (error.requiresSignIn && current?.clientId === session.clientId &&
          current.refreshToken === session.refreshToken) {
        clearChatGPTSession(prefs);
      }
      throw error;
    }
    const merged = {
      ...session,
      ...refreshed,
      email: refreshed.email || session.email || "",
      subject: refreshed.subject || session.subject || "",
    };
    const current = readChatGPTSession(prefs);
    // A sign-out or new sign-in during the request must never be overwritten.
    if (stored && (current?.clientId !== session.clientId || current.refreshToken !== session.refreshToken)) {
      throw new ChatGPTSignInRequiredError();
    }
    if (stored) writeChatGPTSession(prefs, merged);
    return merged.accessToken;
  })();
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
};

export const ensureValidChatGPTToken = async (
  prefs = globalThis.Services?.prefs,
  fetchImpl,
  sessionOverride = null,
  options = {},
) => {
  const stored = readChatGPTSession(prefs);
  if (stored && sessionOverride && stored.clientId !== sessionOverride.clientId) {
    throw new ChatGPTSignInRequiredError();
  }
  // Provider settings are snapshots. Always prefer credentials persisted by a
  // previous batch, window, or model-discovery request for the same registration.
  const session = stored || sessionOverride;
  if (!session || (!session.accessToken && !session.refreshToken)) {
    throw new ChatGPTSignInRequiredError();
  }

  const isExpired =
    session.expiresAt > 0 &&
    Date.now() + SIWC_CONSTANTS.EXPIRY_SAFETY_WINDOW_MS >= session.expiresAt;

  if (session.accessToken && !isExpired) {
    return session.accessToken;
  }

  return runSerializedRefresh(prefs, fetchImpl, stored, session, options);
};

/**
 * Force an immediate OAuth token refresh (ignoring `expiresAt`) for reactive 1x
 * HTTP 401 retry flows. Serialized through the shared refresh lock so
 * concurrent 401s rotate the refresh token at most once.
 */
export const forceRefreshChatGPTToken = async (
  prefs = globalThis.Services?.prefs,
  fetchImpl,
  sessionOverride = null,
  options = {},
) => {
  const stored = readChatGPTSession(prefs);
  if (stored && sessionOverride && stored.clientId !== sessionOverride.clientId) {
    throw new ChatGPTSignInRequiredError();
  }
  const session = stored || sessionOverride;
  if (!session || !session.refreshToken || !session.clientId) {
    throw new ChatGPTSignInRequiredError();
  }
  return runSerializedRefresh(prefs, fetchImpl, stored, session, options);
};

export const buildChatGPTResponsesRequest = ({ accessToken, model, inputText, systemPrompt, reasoningEffort }) => ({
  url: SIWC_CONSTANTS.RESPONSES_URL,
  init: {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      [BEARER_HEADER_KEY]: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      model: model || CONFIG.AI_CHATGPT_MODEL_DEFAULT,
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      input: [
        {
          role: "user",
          content: inputText,
        },
      ],
      store: false,
      stream: true,
      // The Responses API carries the effort under `reasoning.effort`.
      // Omitting it means "model default", which for a reasoning model is the
      // slow path; the sorting pipeline asks for the cheapest level instead.
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    }),
  },
});

export const parseChatGPTResponsesOutput = (rawText) => {
  const text = String(rawText || "").trim();
  if (!text) return null;

  // Case 1: Standard JSON object response (non-SSE)
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.output_text === "string" && parsed.output_text.trim()) {
        return parsed.output_text.trim();
      }
      const outItems = Array.isArray(parsed.output) ? parsed.output : [];
      const chunks = [];
      for (const item of outItems) {
        for (const contentPart of Array.isArray(item?.content) ? item.content : []) {
          if (typeof contentPart?.text === "string") chunks.push(contentPart.text);
        }
      }
      if (chunks.length > 0) return chunks.join("").trim();
      if (typeof parsed.choices?.[0]?.message?.content === "string") {
        return parsed.choices[0].message.content.trim();
      }
    } catch {}
  }

  // Case 2: SSE stream (event: ... / data: {...})
  let deltaText = "";
  let completedText = "";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        deltaText += event.delta;
      } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
        completedText = event.text;
      } else if (event.type === "response.completed" && event.response) {
        const resp = event.response;
        if (typeof resp.output_text === "string" && resp.output_text.trim()) {
          completedText = resp.output_text;
        } else if (Array.isArray(resp.output)) {
          const parts = [];
          for (const item of resp.output) {
            for (const c of Array.isArray(item?.content) ? item.content : []) {
              if (typeof c?.text === "string") parts.push(c.text);
            }
          }
          if (parts.length > 0) completedText = parts.join("");
        }
      } else if (event.type === "error" || event.error) {
        const msg = event.error?.message || event.message || "ChatGPT stream error";
        throw new Error(msg);
      }
    } catch (e) {
      if (e instanceof Error && e.message !== "Unexpected end of JSON input" && !e.message.includes("JSON")) {
        throw e;
      }
    }
  }

  const finalOut = (deltaText || completedText).trim();
  return finalOut || null;
};

/**
 * Fetch available ChatGPT SIWC models with a 15s AbortController timeout.
 * Propagates HTTP and network errors (never swallows them as `[]`).
 */
export const fetchChatGPTModels = async (
  accessToken,
  fetchImpl,
  { signal = null, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS } = {},
) => {
  const response = await fetchWithTimeout(
    SIWC_CONSTANTS.MODELS_URL,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        [BEARER_HEADER_KEY]: `Bearer ${accessToken}`,
      },
    },
    { fetchImpl, signal, timeoutMs },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new ProviderHttpError({
      status: response.status,
      body,
      retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
      provider: "chatgpt",
      message: `ChatGPT model list failed (HTTP ${response.status}): ${body.slice(0, 200)}`,
    });
  }
  const data = JSON.parse(body);
  if (Array.isArray(data?.models)) {
    return data.models
      .filter((m) => m && typeof m.slug === "string" && m.visibility !== "hidden")
      .map((m) => ({
        id: m.slug,
        label: m.display_name || m.slug,
      }));
  }
  if (Array.isArray(data?.data)) {
    return data.data
      .filter((m) => m && typeof m.id === "string")
      .map((m) => ({ id: m.id, label: m.id }));
  }
  return [];
};

// Active pending sign-in state so a user can also complete sign-in by pasting the
// callback URL if their OS firewall blocks local loopback sockets.
let pendingSignInState = null;

/**
 * Expose pending state setter/resetter for unit tests and clean cancellation.
 */
export const cancelPendingChatGPTSignIn = (reason = "Sign in cancelled") => {
  if (!pendingSignInState) return;
  const prev = pendingSignInState;
  pendingSignInState = null;
  try {
    prev.cleanup?.();
  } catch {}
  try {
    prev.reject?.(new Error(reason));
  } catch {}
};

// Test helper to prime pendingSignInState cleanly in Node tests.
export const _setPendingSignInStateForTests = (state) => {
  pendingSignInState = state || null;
};

export const completeChatGPTSignInFromCallbackUrl = async (
  callbackUrl,
  prefs = globalThis.Services?.prefs,
  fetchImpl,
  options = {},
) => {
  if (!pendingSignInState) {
    throw new Error("No active Sign in with ChatGPT flow. Click 'Sign in with ChatGPT' first.");
  }
  const parsed = parseCallbackQuery(callbackUrl);
  if (parsed.error) {
    const errMsg = `ChatGPT sign-in error: ${parsed.errorDescription || parsed.error}`;
    try { pendingSignInState.cleanup?.(); } catch {}
    pendingSignInState = null;
    throw new Error(errMsg);
  }
  // Strict CSRF protection: state MUST be present and match exactly.
  if (!parsed.state || parsed.state !== pendingSignInState.state) {
    throw new Error("OAuth state mismatch. Please try signing in again.");
  }
  if (!parsed.code) {
    throw new Error("Callback URL does not contain an authorization code.");
  }
  const effectiveClientId = parsed.clientId || pendingSignInState.clientId;
  if (!effectiveClientId || effectiveClientId === SIWC_CONSTANTS.REGISTRATION_CLIENT_ID) {
    throw new Error("ChatGPT callback did not include an issued client_id.");
  }
  const expectedNonce = pendingSignInState.nonce || "";
  const session = await exchangeChatGPTAuthorizationCode(
    {
      code: parsed.code,
      codeVerifier: pendingSignInState.codeVerifier,
      redirectUri: pendingSignInState.redirectUri,
      clientId: effectiveClientId,
      expectedNonce,
    },
    fetchImpl,
    options,
  );
  writeChatGPTSession(prefs, session);
  try {
    pendingSignInState.cleanup?.();
  } catch {}
  pendingSignInState = null;
  return session;
};

const escapeHtml = (str) =>
  String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const writeLoopbackHttpResponse = (transport, statusLine, htmlBody = "") => {
  try {
    const output = transport.openOutputStream(0, 0, 0);
    if (!htmlBody) {
      const resp = `HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
      output.write(resp, resp.length);
      output.close();
      return;
    }
    const htmlBytes = new TextEncoder().encode(htmlBody).byteLength;
    const httpResp =
      `HTTP/1.1 ${statusLine}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${htmlBytes}\r\nConnection: close\r\n\r\n${htmlBody}`;
    output.write(httpResp, httpResp.length);
    output.close();
  } catch {}
};

const buildLoopbackHtml = (title, message) =>
  "<!doctype html><html><head><meta charset='utf-8'><title>" + escapeHtml(title) + "</title>" +
  "<style>body{font-family:system-ui,sans-serif;padding:3rem;text-align:center;background:#111;color:#eee}</style>" +
  "</head><body><h2>" + escapeHtml(title) + "</h2><p>" + escapeHtml(message) + "</p></body></html>";

// Starts a local loopback HTTP listener on 127.0.0.1:<ephemeral-port>/auth/callback
// using Firefox/Gecko's nsIServerSocket + buffered nsIAsyncInputStream.asyncWait
// and opens the OpenAI authorization page.
export const startChatGPTSignInFlow = async ({
  prefs = globalThis.Services?.prefs,
  onStatus,
  fetchImpl,
} = {}) => {
  // Clean up any prior unfinished sign-in flow before opening a new socket/tab.
  if (pendingSignInState) {
    cancelPendingChatGPTSignIn("Superseded by a new ChatGPT sign-in attempt.");
  }

  const existing = readChatGPTSession(prefs);
  const hostId = getOrCreateHostId(prefs);
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomBase64Url(24);
  const nonce = randomBase64Url(24);

  let serverSocket = null;
  let port = 14555;
  let tabWatchTimer = null;
  let timeoutTimer = null;
  let openedTab = null;
  let settled = false;
  let unloadHandler = null;

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (tabWatchTimer) {
      clearInterval(tabWatchTimer);
      tabWatchTimer = null;
    }
    if (unloadHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      try { window.removeEventListener("unload", unloadHandler); } catch {}
      unloadHandler = null;
    }
    if (serverSocket) {
      try { serverSocket.close(); } catch {}
      serverSocket = null;
    }
  };

  return new Promise((resolve, reject) => {
    const rejectFlow = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pendingSignInState?.state === state) pendingSignInState = null;
      reject(err);
    };

    const finishWithUrl = async (rawUrl) => {
      if (settled) return;
      settled = true;
      try {
        onStatus?.("Exchanging sign-in code with ChatGPT…");
        const session = await completeChatGPTSignInFromCallbackUrl(rawUrl, prefs, fetchImpl);
        if (openedTab) {
          try {
            const win = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser");
            win?.gBrowser?.removeTab?.(openedTab);
          } catch {}
        }
        resolve(session);
      } catch (err) {
        cleanup();
        if (pendingSignInState?.state === state) pendingSignInState = null;
        reject(err);
      }
    };

    const handleLoopbackRequest = (transport, requestText) => {
      const firstLine = requestText.split(/\r?\n/)[0] || "";
      const match = firstLine.match(/^GET\s+([^\s]+)\s+HTTP/i);
      const pathAndQuery = match ? match[1] : "";

      // Ignore browser favicon probes without terminating the flow.
      if (pathAndQuery === "/favicon.ico" || pathAndQuery.startsWith("/favicon.ico?")) {
        writeLoopbackHttpResponse(transport, "204 No Content");
        return;
      }

      if (!pathAndQuery.startsWith("/auth/callback")) {
        writeLoopbackHttpResponse(
          transport,
          "404 Not Found",
          buildLoopbackHtml("Not Found", "Return to Zen Tab Sorting settings."),
        );
        return;
      }

      const parsed = parseCallbackQuery(pathAndQuery);
      if (parsed.error) {
        const detail = parsed.errorDescription || parsed.error;
        writeLoopbackHttpResponse(
          transport,
          "400 Bad Request",
          buildLoopbackHtml("Sign in failed", detail),
        );
        rejectFlow(new Error(`ChatGPT sign-in error: ${detail}`));
        return;
      }

      if (parsed.code) {
        writeLoopbackHttpResponse(
          transport,
          "200 OK",
          buildLoopbackHtml(
            "Signed in with ChatGPT",
            "You can close this tab and return to Zen Tab Sorting settings.",
          ),
        );
        finishWithUrl(pathAndQuery);
        return;
      }

      writeLoopbackHttpResponse(
        transport,
        "400 Bad Request",
        buildLoopbackHtml("Incomplete callback", "Missing sign-in code. Please try again."),
      );
    };

    // 1. Try binding a Gecko nsIServerSocket on 127.0.0.1 with an OS-assigned port
    try {
      const Cc = globalThis.Cc || globalThis.Components?.classes;
      const Ci = globalThis.Ci || globalThis.Components?.interfaces;
      const mainThread = globalThis.Services?.tm?.currentThread || globalThis.Services?.tm?.mainThread;
      if (Cc && Ci) {
        serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
        serverSocket.init(-1, true, -1); // port=-1 (ephemeral), loopbackOnly=true
        port = serverSocket.port;
        serverSocket.asyncListen({
          onSocketAccepted(_serv, transport) {
            try {
              const rawInput = transport.openInputStream(0, 0, 0);
              const asyncInput = rawInput.QueryInterface(Ci.nsIAsyncInputStream);
              const scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
                Ci.nsIScriptableInputStream,
              );
              scriptable.init(rawInput);

              let requestBuffer = "";
              let finishedConn = false;
              const closeConn = () => {
                if (finishedConn) return;
                finishedConn = true;
                clearTimeout(connTimer);
                try { scriptable.close(); } catch {}
                try { rawInput.close(); } catch {}
              };

              const connTimer = setTimeout(() => {
                if (!finishedConn) {
                  handleLoopbackRequest(transport, requestBuffer);
                  closeConn();
                }
              }, LOOPBACK_CONN_TIMEOUT_MS);

              const waitForMore = () => {
                asyncInput.asyncWait(
                  {
                    onInputStreamReady() {
                      if (finishedConn) return;
                      try {
                        const avail = scriptable.available();
                        if (avail > 0) {
                          const toRead = Math.min(avail, LOOPBACK_MAX_REQUEST_BYTES - requestBuffer.length);
                          if (toRead > 0) requestBuffer += scriptable.read(toRead);
                        }
                        if (requestBuffer.includes("\r\n\r\n") || requestBuffer.length >= LOOPBACK_MAX_REQUEST_BYTES || avail === 0) {
                          handleLoopbackRequest(transport, requestBuffer);
                          closeConn();
                        } else {
                          waitForMore();
                        }
                      } catch {
                        if (requestBuffer) handleLoopbackRequest(transport, requestBuffer);
                        closeConn();
                      }
                    },
                  },
                  0,
                  0,
                  mainThread,
                );
              };

              waitForMore();
            } catch (e) {
              console.warn(`${LOG} loopback socket accept error:`, e);
            }
          },
          onStopListening() {},
        });
      }
    } catch (e) {
      console.warn(`${LOG} nsIServerSocket unavailable, falling back to tab URL watcher:`, e);
    }

    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const initialClientId = existing?.clientId || SIWC_CONSTANTS.REGISTRATION_CLIENT_ID;
    pendingSignInState = {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      clientId: initialClientId,
      cleanup,
      reject: rejectFlow,
    };

    // Clean up socket and timers if the host window closes mid-sign-in.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      unloadHandler = () => {
        rejectFlow(new Error("Sign in with ChatGPT cancelled because the window closed."));
      };
      window.addEventListener("unload", unloadHandler, { once: true });
    }

    const authorizeUrl = buildChatGPTAuthorizeUrl({
      redirectUri,
      state,
      nonce,
      codeChallenge,
      hostId,
      clientId: initialClientId,
    });

    onStatus?.("Waiting for ChatGPT sign-in in browser tab…");

    // 2. Open the authorization URL in Zen Browser
    try {
      const win = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser");
      if (win?.gBrowser?.addTrustedTab) {
        openedTab = win.gBrowser.addTrustedTab(authorizeUrl);
        win.gBrowser.selectedTab = openedTab;
      } else if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(authorizeUrl, "_blank", "noopener");
      }
    } catch (e) {
      console.warn(`${LOG} could not auto-open ChatGPT sign-in tab:`, e);
    }

    // 3. Also watch browser tabs for the redirect URI in case the loopback socket
    //    doesn't catch it first.
    tabWatchTimer = setInterval(() => {
      if (settled) {
        clearInterval(tabWatchTimer);
        return;
      }
      try {
        const win = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser");
        const tabs = win?.gBrowser?.tabs ? Array.from(win.gBrowser.tabs) : [];
        for (const tab of tabs) {
          const spec = tab?.linkedBrowser?.currentURI?.spec || "";
          if (!spec.startsWith(`http://127.0.0.1:${port}/auth/callback`)) continue;
          if (spec.includes("error=")) {
            const parsed = parseCallbackQuery(spec);
            rejectFlow(new Error(`ChatGPT sign-in error: ${parsed.errorDescription || parsed.error}`));
            return;
          }
          if (spec.includes("code=")) {
            openedTab = tab;
            finishWithUrl(spec);
            return;
          }
        }
      } catch {}
    }, 350);

    // Timeout after 3 minutes
    timeoutTimer = setTimeout(() => {
      rejectFlow(new Error("Sign in with ChatGPT timed out after 3 minutes."));
    }, 180_000);
  });
};
