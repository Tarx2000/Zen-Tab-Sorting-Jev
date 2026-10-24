import test from "node:test";
import assert from "node:assert/strict";

import {
  SIWC_CONSTANTS,
  buildChatGPTAuthorizeUrl,
  buildChatGPTResponsesRequest,
  ensureValidChatGPTToken,
  exchangeChatGPTAuthorizationCode,
  generatePkcePair,
  parseCallbackQuery,
  parseChatGPTResponsesOutput,
} from "../modules/chatgpt-auth.mjs";

test("Given Sign in with ChatGPT parameters When building authorize URL Then dynamic_agent_client, PKCE, and direct token scopes are included", async () => {
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  assert.ok(codeVerifier.length >= 40);
  assert.ok(codeChallenge.length >= 40);

  const url = buildChatGPTAuthorizeUrl({
    redirectUri: "http://127.0.0.1:14555/auth/callback",
    state: "state-123",
    nonce: "nonce-456",
    codeChallenge,
    hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
  });

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, SIWC_CONSTANTS.AUTHORIZE_URL);
  assert.equal(parsed.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(parsed.searchParams.get("agent_name_hint"), "Zen Tab Sorting");
  assert.equal(parsed.searchParams.get("ext_agent_host_id"), "urn:uuid:11111111-2222-3333-4444-555555555555");
  assert.equal(parsed.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.match(parsed.searchParams.get("scope"), /chatgpt\.tokens\.use\.direct/);
});

test("Given callback URL with issued client_id When parsed and exchanged Then token exchange sends issued client_id", async () => {
  const cb = parseCallbackQuery(
    "http://127.0.0.1:14555/auth/callback?code=auth_code_99&state=st_1&client_id=oaiapp_abc123&scope=openid",
  );
  assert.equal(cb.code, "auth_code_99");
  assert.equal(cb.state, "st_1");
  assert.equal(cb.clientId, "oaiapp_abc123");

  let capturedUrl = "";
  let capturedBody = "";
  const session = await exchangeChatGPTAuthorizationCode(
    {
      code: cb.code,
      codeVerifier: "verifier_xyz",
      redirectUri: "http://127.0.0.1:14555/auth/callback",
      clientId: cb.clientId,
    },
    async (url, init) => {
      capturedUrl = url;
      capturedBody = init.body;
      return new Response(
        JSON.stringify({
          access_token: "at_live_1",
          refresh_token: "rt_live_1",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
        }),
        { status: 200 },
      );
    },
  );

  assert.equal(capturedUrl, SIWC_CONSTANTS.TOKEN_URL);
  assert.match(capturedBody, /client_id=oaiapp_abc123/);
  assert.match(capturedBody, /code=auth_code_99/);
  assert.equal(session.accessToken, "at_live_1");
  assert.equal(session.refreshToken, "rt_live_1");
  assert.equal(session.clientId, "oaiapp_abc123");
});

test("Given expired ChatGPT session with refresh_token When ensureValidChatGPTToken runs Then token is refreshed automatically", async () => {
  const expiredSession = {
    clientId: "oaiapp_abc123",
    accessToken: "old_token",
    refreshToken: "rt_valid",
    expiresAt: Date.now() - 10_000,
  };

  const freshToken = await ensureValidChatGPTToken(
    null,
    async (url, init) => {
      assert.equal(url, SIWC_CONSTANTS.TOKEN_URL);
      assert.match(init.body, /grant_type=refresh_token/);
      return new Response(
        JSON.stringify({
          access_token: "new_refreshed_token",
          refresh_token: "rt_rotated",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    },
    expiredSession,
  );

  assert.equal(freshToken, "new_refreshed_token");
});

test("Given /v1/responses SSE stream When parsed Then delta chunks are reassembled into JSON string", () => {
  const req = buildChatGPTResponsesRequest({
    accessToken: "at_123",
    model: "gpt-5-codex-mini",
    inputText: "Group tabs",
  });
  assert.equal(req.url, "https://api.openai.com/v1/responses");
  const body = JSON.parse(req.init.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);

  const sseStream = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"{\\"0\\": "}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"\\"Design\\"}"}',
    '',
    'data: [DONE]',
  ].join("\n");

  const output = parseChatGPTResponsesOutput(sseStream);
  assert.equal(output, '{"0": "Design"}');
});

const sessionPrefs = (session) => {
  let raw = JSON.stringify(session);
  return {
    prefHasUserValue: () => Boolean(raw),
    getStringPref: () => raw,
    setStringPref: (_name, value) => { raw = value; },
    clearUserPref: () => { raw = ""; },
  };
};
const expired = (clientId) => ({ clientId, accessToken: "old", refreshToken: "rotation-1", expiresAt: 1, email: "test@example.invalid" });

test("Provider snapshots persist rotating refresh tokens and reuse the stored replacement", async () => {
  const snapshot = expired("rotation-client");
  const prefs = sessionPrefs(snapshot);
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    assert.equal(new URLSearchParams(init.body).get("refresh_token"), "rotation-1");
    return Response.json({ access_token: "replacement", refresh_token: "rotation-2", expires_in: 3600 });
  };
  assert.equal(await ensureValidChatGPTToken(prefs, fetchImpl, snapshot), "replacement");
  assert.equal(await ensureValidChatGPTToken(prefs, fetchImpl, snapshot), "replacement");
  assert.equal(calls, 1);
  const saved = JSON.parse(prefs.getStringPref());
  assert.equal(saved.refreshToken, "rotation-2");
  assert.equal(saved.email, snapshot.email);
});

test("Concurrent callers share one rotating-token refresh", async () => {
  const snapshot = expired("concurrent-client");
  const prefs = sessionPrefs(snapshot);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await gate;
    return Response.json({ access_token: "fresh", refresh_token: "next", expires_in: 3600 });
  };
  const a = ensureValidChatGPTToken(prefs, fetchImpl, snapshot);
  const b = ensureValidChatGPTToken(prefs, fetchImpl, snapshot);
  release();
  assert.deepEqual(await Promise.all([a, b]), ["fresh", "fresh"]);
  assert.equal(calls, 1);
});

test("A rejected refresh clears unusable credentials but retains the issued client ID", async () => {
  const snapshot = expired("revoked-client");
  const prefs = sessionPrefs(snapshot);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  };
  await assert.rejects(ensureValidChatGPTToken(prefs, fetchImpl, snapshot), { code: "chatgpt_sign_in_required" });
  await assert.rejects(ensureValidChatGPTToken(prefs, fetchImpl, snapshot), { code: "chatgpt_sign_in_required" });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(prefs.getStringPref()).clientId, snapshot.clientId);
  assert.equal(JSON.parse(prefs.getStringPref()).refreshToken, "");
});

test("Transient refresh failures preserve credentials and sign-out during refresh stays signed out", async () => {
  const snapshot = expired("transient-client");
  const prefs = sessionPrefs(snapshot);
  await assert.rejects(ensureValidChatGPTToken(prefs, async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 }), snapshot));
  assert.deepEqual(JSON.parse(prefs.getStringPref()), snapshot);
  await assert.rejects(ensureValidChatGPTToken(prefs, async () => {
    prefs.setStringPref("", JSON.stringify({ clientId: snapshot.clientId, accessToken: "", refreshToken: "", expiresAt: 0 }));
    return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
  }, snapshot), { code: "chatgpt_sign_in_required" });
  assert.equal(JSON.parse(prefs.getStringPref()).accessToken, "");
});
