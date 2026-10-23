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
