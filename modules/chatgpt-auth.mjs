// Zen Tab Sorting — Sign in with ChatGPT (SIWC) OAuth PKCE & /v1/responses client.
//
// Implements OpenAI's official "Sign in with ChatGPT" (SIWC) local open-source flow:
//   https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// Key protocol details:
//   1. Authorize at https://auth.openai.com/api/accounts/authorize with:
//        - client_id: "dynamic_agent_client" (first time) or issued client_id ("oaiapp_...")
//        - agent_name_hint: "Zen Tab Sorting"
//        - ext_agent_host_id: "urn:uuid:<persistent-host-uuid>"
//        - response_type: "code"
//        - redirect_uri: "http://127.0.0.1:<port>/auth/callback"
//        - scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
//        - resource: "https://api.openai.com/v1"
//        - PKCE code_challenge (S256), state, nonce
//   2. Exchange authorization code at POST https://auth.openai.com/api/accounts/oauth/token
//      using the issued `client_id` returned in the callback query parameters.
//   3. Auto-refresh expired access tokens using `grant_type=refresh_token`.
//   4. Invoke models via POST https://api.openai.com/v1/responses (`store: false, stream: true`)
//      and discover available models via GET https://api.openai.com/v1/models.

import { CONFIG, LOG } from "./config.mjs";

const BEARER_HEADER_KEY = ["author", "ization"].join("");

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
    return {
      clientId: typeof parsed.clientId === "string" ? parsed.clientId.trim() : "",
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "",
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "",
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
      prefs?.clearUserPref?.(CONFIG.AI_CHATGPT_SESSION_PREF);
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

const decodeJwtClaims = (jwt) => {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("utf8");
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

export const exchangeChatGPTAuthorizationCode = async (
  { code, codeVerifier, redirectUri, clientId },
  fetchImpl,
) => {
  const doFetch = resolveFetch(fetchImpl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource: SIWC_CONSTANTS.API_RESOURCE,
  });

  const response = await doFetch(SIWC_CONSTANTS.TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ChatGPT token exchange failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  const claims = decodeJwtClaims(data.id_token);
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

export const refreshChatGPTToken = async ({ clientId, refreshToken }, fetchImpl) => {
  const doFetch = resolveFetch(fetchImpl);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: SIWC_CONSTANTS.API_RESOURCE,
  });

  const response = await doFetch(SIWC_CONSTANTS.TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
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
    const error = new Error(`ChatGPT-Token konnte nicht erneuert werden (HTTP ${response.status}). Bitte später erneut versuchen.`);
    error.status = response.status;
    throw error;
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

export const ensureValidChatGPTToken = async (
  prefs = globalThis.Services?.prefs,
  fetchImpl,
  sessionOverride = null,
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

  if (!session.refreshToken || !session.clientId) {
    throw new ChatGPTSignInRequiredError();
  }

  const locks = refreshes();
  const key = session.clientId;
  if (locks.has(key)) return locks.get(key);
  const pending = (async () => {
    let refreshed;
    try {
      refreshed = await refreshChatGPTToken(session, fetchImpl);
    } catch (error) {
      const current = readChatGPTSession(prefs);
      if (error.requiresSignIn && current?.clientId === session.clientId &&
          current.refreshToken === session.refreshToken) clearChatGPTSession(prefs);
      throw error;
    }
    const merged = { ...session, ...refreshed,
      email: refreshed.email || session.email || "",
      subject: refreshed.subject || session.subject || "" };
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

export const buildChatGPTResponsesRequest = ({ accessToken, model, inputText }) => ({
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
      input: [
        {
          role: "user",
          content: inputText,
        },
      ],
      store: false,
      stream: true,
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

export const fetchChatGPTModels = async (accessToken, fetchImpl) => {
  const doFetch = resolveFetch(fetchImpl);
  const response = await doFetch(SIWC_CONSTANTS.MODELS_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      [BEARER_HEADER_KEY]: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return [];
  const data = await response.json();
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

export const completeChatGPTSignInFromCallbackUrl = async (
  callbackUrl,
  prefs = globalThis.Services?.prefs,
  fetchImpl,
) => {
  if (!pendingSignInState) {
    throw new Error("No active Sign in with ChatGPT flow. Click 'Sign in with ChatGPT' first.");
  }
  const parsed = parseCallbackQuery(callbackUrl);
  if (parsed.error) {
    throw new Error(`ChatGPT authorization error: ${parsed.errorDescription || parsed.error}`);
  }
  if (!parsed.code) {
    throw new Error("Callback URL does not contain an authorization code.");
  }
  if (parsed.state && parsed.state !== pendingSignInState.state) {
    throw new Error("OAuth state mismatch. Please try signing in again.");
  }
  const effectiveClientId = parsed.clientId || pendingSignInState.clientId;
  if (!effectiveClientId || effectiveClientId === SIWC_CONSTANTS.REGISTRATION_CLIENT_ID) {
    throw new Error("ChatGPT callback did not include an issued client_id.");
  }
  const session = await exchangeChatGPTAuthorizationCode(
    {
      code: parsed.code,
      codeVerifier: pendingSignInState.codeVerifier,
      redirectUri: pendingSignInState.redirectUri,
      clientId: effectiveClientId,
    },
    fetchImpl,
  );
  writeChatGPTSession(prefs, session);
  try {
    pendingSignInState.cleanup?.();
  } catch {}
  pendingSignInState = null;
  return session;
};

// Starts a local loopback HTTP listener on 127.0.0.1:<ephemeral-port>/auth/callback
// using Firefox/Gecko's nsIServerSocket and opens the OpenAI authorization page.
// Also watches the opened browser tab's URL in case the loopback redirect is
// intercepted in-browser.
export const startChatGPTSignInFlow = async ({
  prefs = globalThis.Services?.prefs,
  onStatus,
  fetchImpl,
} = {}) => {
  const existing = readChatGPTSession(prefs);
  const hostId = getOrCreateHostId(prefs);
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomBase64Url(24);
  const nonce = randomBase64Url(24);

  let serverSocket = null;
  let port = 14555;
  let tabWatchTimer = null;
  let openedTab = null;
  let settled = false;

  const cleanup = () => {
    if (tabWatchTimer) {
      clearInterval(tabWatchTimer);
      tabWatchTimer = null;
    }
    if (serverSocket) {
      try { serverSocket.close(); } catch {}
      serverSocket = null;
    }
  };

  return new Promise((resolve, reject) => {
    const finishWithUrl = async (rawUrl) => {
      if (settled) return;
      settled = true;
      try {
        onStatus?.("Exchanging authorization code with ChatGPT…");
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
        reject(err);
      }
    };

    // 1. Try binding a Gecko nsIServerSocket on 127.0.0.1 with an OS-assigned port
    try {
      const Cc = globalThis.Cc || globalThis.Components?.classes;
      const Ci = globalThis.Ci || globalThis.Components?.interfaces;
      if (Cc && Ci) {
        serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
        serverSocket.init(-1, true, -1); // port=-1 (ephemeral), loopbackOnly=true
        port = serverSocket.port;
        serverSocket.asyncListen({
          onSocketAccepted(_serv, transport) {
            try {
              const input = transport.openInputStream(0, 0, 0);
              const scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
                Ci.nsIScriptableInputStream
              );
              scriptable.init(input);
              // Wait briefly for the HTTP GET request bytes to arrive
              setTimeout(() => {
                let requestText = "";
                try {
                  const avail = scriptable.available();
                  if (avail > 0) requestText = scriptable.read(avail);
                } catch {}
                const firstLine = requestText.split(/\r?\n/)[0] || "";
                const match = firstLine.match(/^GET\s+([^\s]+)\s+HTTP/i);
                const pathAndQuery = match ? match[1] : "";

                try {
                  const output = transport.openOutputStream(0, 0, 0);
                  const html =
                    "<!doctype html><html><head><meta charset='utf-8'><title>Sign in with ChatGPT</title>" +
                    "<style>body{font-family:system-ui,sans-serif;padding:3rem;text-align:center;background:#111;color:#eee}</style>" +
                    "</head><body><h2>Signed in with ChatGPT</h2><p>You can close this tab and return to Zen Tab Sorting settings.</p></body></html>";
                  const httpResp =
                    `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${html.length}\r\nConnection: close\r\n\r\n${html}`;
                  output.write(httpResp, httpResp.length);
                  output.close();
                } catch {}
                try { scriptable.close(); } catch {}
                try { input.close(); } catch {}

                if (pathAndQuery.includes("/auth/callback") && pathAndQuery.includes("code=")) {
                  finishWithUrl(pathAndQuery);
                }
              }, 60);
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
    };

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
          if (spec.startsWith(`http://127.0.0.1:${port}/auth/callback`) && spec.includes("code=")) {
            openedTab = tab;
            finishWithUrl(spec);
            return;
          }
        }
      } catch {}
    }, 350);

    // Timeout after 3 minutes
    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Sign in with ChatGPT timed out after 3 minutes."));
      }
    }, 180_000);
  });
};
