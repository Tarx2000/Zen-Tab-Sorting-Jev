import test from "node:test";
import assert from "node:assert/strict";

import { buildZenEnv } from "../scripts/zen-e2e-driver.mjs";
import { helpText, parseArgs } from "../scripts/zen-e2e-harness.mjs";
import { scenarioPrefs } from "../scripts/zen-e2e-profile.mjs";
import { promptLines } from "../scripts/zen-e2e-servers.mjs";

test("Given no Zen E2E args When parsed Then defaults target the full isolated gate", () => {
  const options = parseArgs([]);

  assert.equal(options.scenario, "all");
  assert.equal(options.tabs, 120);
  assert.equal(options.headed, false);
  assert.equal(options.keepProfile, false);
  assert.equal(options.holdOpenMs, 0);
  assert.ok(options.zenBinary.endsWith("/Zen.app/Contents/MacOS/zen"));
});

test("Given explicit Zen E2E args When parsed Then scenario and launch options are honored", () => {
  const options = parseArgs([
    "--scenario",
    "full-ai",
    "--tabs",
    "240",
    "--headed",
    "--keep-profile",
    "--hold-open-ms",
    "1500",
    "--zen-binary",
    "/tmp/zen",
    "--sine-profile",
    "/tmp/profile",
  ]);

  assert.equal(options.scenario, "full-ai");
  assert.equal(options.tabs, 240);
  assert.equal(options.headed, true);
  assert.equal(options.keepProfile, true);
  assert.equal(options.holdOpenMs, 1500);
  assert.equal(options.zenBinary, "/tmp/zen");
  assert.equal(options.sineProfile, "/tmp/profile");
});

test("Given real provider Zen E2E args When parsed Then the scorer artifact is required", () => {
  assert.throws(
    () => parseArgs(["--provider", "real", "--scenario", "full-ai"]),
    /--quality-artifact is required when --provider real/,
  );

  const options = parseArgs([
    "--provider",
    "real",
    "--scenario",
    "hybrid",
    "--quality-artifact",
    "/tmp/zen-quality.json",
  ]);

  assert.equal(options.provider, "real");
  assert.equal(options.scenario, "hybrid");
  assert.equal(options.qualityArtifact, "/tmp/zen-quality.json");
});

test("Given Zen E2E launches When building browser env Then provider secrets stay in the Node proxy", () => {
  const env = buildZenEnv({
    PATH: "/bin",
    OPENROUTER_API_KEY: "sk-real",
    OPENROUTER_MODEL: "google/gemini-3.5-flash",
    CUSTOM_TOKEN: "secret-token",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SECRET_KEY_BASE: "rails-secret",
    PRIVATE_KEY: "private-secret",
    SERVICE_CREDENTIALS: "creds",
  }, false, 4545);

  assert.equal(env.PATH, "/bin");
  assert.equal(env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, "1");
  assert.equal(env.MOZ_HEADLESS, "1");
  assert.equal(env.MOZ_MARIONETTE_PORT, "4545");
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.OPENROUTER_MODEL, undefined);
  assert.equal(env.CUSTOM_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.SECRET_KEY_BASE, undefined);
  assert.equal(env.PRIVATE_KEY, undefined);
  assert.equal(env.SERVICE_CREDENTIALS, undefined);
});

test("Given Zen E2E profile prefs When prepared Then Marionette uses the reserved lab port", () => {
  const prefs = scenarioPrefs({ scenario: "full-ai", providerPort: 1234, marionettePort: 4545 });

  assert.deepEqual(prefs.find(([name]) => name === "marionette.port"), ["marionette.port", 4545]);
});

test("Given invalid Zen E2E args When parsed Then the operator gets a bounded error", () => {
  assert.throws(() => parseArgs(["--scenario", "maybe"]), /--scenario must be/);
  assert.throws(() => parseArgs(["--provider", "maybe"]), /--provider must be/);
  assert.throws(() => parseArgs(["--tabs", "3"]), /--tabs must be/);
  assert.throws(() => parseArgs(["--hold-open-ms", "-1"]), /--hold-open-ms must be/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
  assert.match(helpText(), /--scenario <all\|full-ai\|hybrid>/);
  assert.match(helpText(), /--provider <fake\|real>/);
});

test("Given system+user untrusted_tabs_data JSON or legacy regex messages When parsing promptLines Then both formats extract tabs", () => {
  const jsonLines = promptLines({
    messages: [
      { role: "system", content: "You are a tab organizer." },
      {
        role: "user",
        content:
          'Ungrouped Tabs:\n<untrusted_tabs_data>\n[{"id":0,"host":"github.com","title":"Pull Request #42"},{"index":1,"hostname":"figma.com","title":"Design Tokens"}]\n</untrusted_tabs_data>',
      },
    ],
  });
  assert.deepEqual(jsonLines, [
    { index: "0", host: "github.com", title: "Pull Request #42" },
    { index: "1", host: "figma.com", title: "Design Tokens" },
  ]);

  const legacyLines = promptLines({
    messages: [
      {
        role: "user",
        content: 'Tabs:\n0. docs.rs — "Rust Docs"\n1. amazon.com — "Mechanical Keyboard"',
      },
    ],
  });
  assert.deepEqual(legacyLines, [
    { index: "0", host: "docs.rs", title: "Rust Docs" },
    { index: "1", host: "amazon.com", title: "Mechanical Keyboard" },
  ]);
});
