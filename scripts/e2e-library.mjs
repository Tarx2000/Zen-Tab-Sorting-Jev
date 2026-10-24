#!/usr/bin/env node
// Actual Library copies and normal Autosort in an isolated Sine profile.
// OAuth and inference responses are intercepted; no live account is used.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConnectedProfile, delay, launchZen, stopZen } from "./zen-e2e-driver.mjs";
import { createLabProfile, findDefaultSineProfile, removeLabProfile, scenarioPrefs, writeUserPrefs } from "./zen-e2e-profile.mjs";
import { MarionetteClient, reserveTcpPort } from "./zen-e2e-marionette.mjs";
import { startFixturePageServer } from "./zen-e2e-servers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lab = await createLabProfile(root, await findDefaultSineProfile());
const port = await reserveTcpPort();
const pages = await startFixturePageServer();
let zen, client;
const execute = async script => {
  const result = await client.executeAsync(`
    const done = arguments[arguments.length - 1];
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    (async () => { ${script} })().then(value => done({ value })).catch(error => done({ error: error.stack || error.message }));
  `);
  if (result?.error) throw new Error(result.error);
  return result?.value;
};
const waitFor = async script => {
  const end = Date.now() + 25000;
  let state;
  do {
    state = await execute(script);
    if (state) return state;
    await delay(100);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for: ${script}`);
};
try {
  await writeUserPrefs(lab.profileDir, [
    ...scenarioPrefs({ scenario: "full-ai", providerPort: 1, marionettePort: port }),
    ["extensions.zen-auto-organize.ai-engine", "chatgpt"],
    ["zen.library.enabled", true],
    ["ui.prefersReducedMotion", 1],
    ["extensions.zen-auto-organize.ai-chatgpt-session-json", JSON.stringify({
      clientId: "library-test-client", accessToken: "expired-test-access", refreshToken: "test-rotation-1", expiresAt: 1,
    })],
  ]);
  zen = launchZen({ options: { headed: process.argv.includes("--headed"), zenBinary: process.env.ZEN_BINARY || "/Applications/Zen.app/Contents/MacOS/zen" }, profileDir: lab.profileDir, marionettePort: port });
  client = await MarionetteClient.connect(port);
  await client.newSession();
  await client.setScriptTimeout();
  await client.setChromeContext();
  await assertConnectedProfile(client, lab.profileDir);
  await waitFor(`return !!win.ZenTabSorting?.handleOrganizeClick;`);
  await execute(`
    const manager = win.gZenWorkspaces;
    const source = manager.activeWorkspace;
    const originalTab = win.gBrowser.selectedTab;
    const target = await manager.createAndSaveWorkspace("Library Sort Target", "○");
    await manager.changeWorkspaceWithID(target.uuid);
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const tabs = ["Library Design A", "Library Design B"].map((name, index) => {
      const tab = win.gBrowser.addTab("http://127.0.0.1:${pages.port}/library-" + index,
        { inBackground: true, triggeringPrincipal: principal });
      tab.setAttribute("label", name);
      return tab;
    });
    for (const tab of [...win.gBrowser.tabs]) if (!tabs.includes(tab) && !tab.hasAttribute("zen-essential")) win.gBrowser.removeTab(tab, { animate: false });
    await manager.changeWorkspaceWithID(source);
    win.gBrowser.selectedTab = originalTab;
    const original = win.fetch.bind(win);
    win.__libraryLab = { source, target: target.uuid, tabs, originalTab, tokenCalls: 0, providerCalls: 0, invalid: false };
    win.fetch = async (url, init) => {
      const s = win.__libraryLab;
      if (String(url).includes("/oauth/token")) {
        s.tokenCalls++;
        if (s.invalid) return new win.Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        const token = new URLSearchParams(init.body).get("refresh_token");
        if (token !== "test-rotation-1") throw new Error("Unexpected test refresh token");
        return new win.Response(JSON.stringify({ access_token: "fresh-test-access", refresh_token: "test-rotation-2", expires_in: 3600 }));
      }
      if (String(url).includes("/v1/responses")) {
        s.providerCalls++;
        const header = init.headers.authorization;
        if (header !== "Bearer fresh-test-access") throw new Error("Stale test access token used");
        await new Promise(resolve => win.setTimeout(resolve, 100));
        return new win.Response(JSON.stringify({ output_text: JSON.stringify({ "0": "Library Design", "1": "Library Design" }) }));
      }
      return original(url, init);
    };
    win.document.querySelector("zen-library").constructor.toggle("spaces");
  `);
  await waitFor(`return [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].some(card => card.dataset.uuid === win.__libraryLab.target && card.querySelector('[id^="tab-wand-button"]'));`);
  const before = await execute(`
    const s = win.__libraryLab;
    const card = [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].find(card => card.dataset.uuid === s.target);
    card.scrollIntoView();
    // Reproduce old duplicate markup and prove the observer normalizes it.
    const button = card.querySelector('[id^="tab-wand-button"]');
    button.parentElement.appendChild(button.cloneNode(true));
    await new Promise(resolve => win.setTimeout(resolve, 100));
    return { count: card.querySelectorAll('[id^="tab-wand-button"]').length,
      visible: (() => { const rect = card.querySelector('[id^="tab-wand-button"]').getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })(),
      commands: [...card.querySelectorAll('[id^="tab-wand-button"]')].map(button => button.getAttribute("command")) };
  `);
  assert.equal(before.count, 1);
  assert.equal(before.visible, true);
  assert.deepEqual(before.commands, [null]);
  await execute(`
    const card = [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].find(card => card.dataset.uuid === win.__libraryLab.target);
    card.querySelector('[id^="tab-wand-button"]').click();
  `);
  await waitFor(`return win.__libraryLab.providerCalls > 0 && !win._zaoSortSession;`);
  const state = await execute(`
    const s = win.__libraryLab;
    const card = [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].find(card => card.dataset.uuid === s.target);
    const session = JSON.parse(Services.prefs.getStringPref("extensions.zen-auto-organize.ai-chatgpt-session-json"));
    return { tokenCalls: s.tokenCalls, providerCalls: s.providerCalls, rotationSaved: session.refreshToken === "test-rotation-2",
      sourcePreserved: win.gZenWorkspaces.activeWorkspace === s.source && win.gBrowser.selectedTab === s.originalTab,
      realGrouped: s.tabs.every(tab => tab.closest("tab-group")?.label === "Library Design" && tab.getAttribute("zen-workspace-id") === s.target),
      copyGrouped: !!card.querySelector('tab-group[label="Library Design"]'), visible: (() => { const rect = card.querySelector('[id^="tab-wand-button"]').getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })(), count: card.querySelectorAll('[id^="tab-wand-button"]').length };
  `);
  console.log(JSON.stringify({ library: state }));
  assert.equal(state.realGrouped, true);
  assert.equal(state.copyGrouped, true);
  assert.equal(state.sourcePreserved, true);
  assert.equal(state.rotationSaved, true);
  assert.equal(state.tokenCalls, 1);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.count, 1);
  assert.equal(state.visible, true);
  if (process.env.ZEN_LIBRARY_SCREENSHOT) {
    const png = await client.command("WebDriver:TakeScreenshot", { full: true });
    await writeFile(process.env.ZEN_LIBRARY_SCREENSHOT, Buffer.from(png.value || png, "base64"));
  }
  // Native refresh creates fresh copies; their command activation must still
  // route once to the same real Space and reuse the saved access token.
  await execute(`
    win.document.querySelector("zen-library-spaces-section").refreshStripsNow();
    await new Promise(resolve => win.setTimeout(resolve, 100));
    const card = [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].find(card => card.dataset.uuid === win.__libraryLab.target);
    if (card.querySelectorAll('[id^="tab-wand-button"]').length !== 1) throw new Error("Duplicate after native refresh");
    card.querySelector('[id^="tab-wand-button"]').dispatchEvent(new win.Event("command", { bubbles: true, cancelable: true }));
  `);
  await waitFor(`return win.__libraryLab.providerCalls === 2 && !win._zaoSortSession;`);
  assert.equal(await execute(`return win.__libraryLab.tokenCalls;`), 1);
  assert.equal(await execute(`return win.gZenWorkspaces.activeWorkspace === win.__libraryLab.source;`), true);
  // Run the real normal Jev→ChatGPT fallback path with a terminal OAuth error.
  await execute(`
    const s = win.__libraryLab;
    await win.gZenWorkspaces.changeWorkspaceWithID(s.target);
    win.gBrowser.ungroupTab(s.tabs[0]);
    win.gBrowser.ungroupTab(s.tabs[1]);
    Services.prefs.setStringPref("extensions.zen-auto-organize.ai-engine", "jev");
    Services.prefs.setStringPref("extensions.zen-auto-organize.ai-fallback-provider", "chatgpt");
    Services.prefs.setStringPref("extensions.zen-auto-organize.ai-chatgpt-session-json", JSON.stringify({ clientId: "library-test-client", accessToken: "expired", refreshToken: "revoked", expiresAt: 1 }));
    s.invalid = true;
    await win.ZenTabSorting.handleOrganizeClick();
  `);
  const failed = await execute(`
    const s = win.__libraryLab;
    const session = JSON.parse(Services.prefs.getStringPref("extensions.zen-auto-organize.ai-chatgpt-session-json"));
    return { tokenCalls: s.tokenCalls, providerCalls: s.providerCalls, cleared: !session.refreshToken && !session.accessToken,
      retainedClient: session.clientId === "library-test-client", busy: !!win._zaoSortSession,
      toast: [...win.document.querySelectorAll('[id*="toast"]')].map(node => node.textContent).join(" ") };
  `);
  console.log(JSON.stringify({ revoked: failed }));
  assert.equal(failed.tokenCalls, 2);
  assert.equal(failed.providerCalls, 2);
  assert.equal(failed.cleared, true);
  assert.equal(failed.retainedClient, true);
  assert.equal(failed.busy, false);
  assert.match(failed.toast, /erneut mit ChatGPT anmelden/);
  assert.doesNotMatch(failed.toast, /Schema-Fehler/);
  assert.equal(failed.toast.match(/erneut mit ChatGPT anmelden/g)?.length, 1);
  console.log("library-e2e: PASS single functional card icon, target scope, copied UI refresh, OAuth rotation and revoked-session recovery");
} finally {
  try { await client?.quit(); } catch {}
  await stopZen(zen);
  await pages.close();
  await removeLabProfile(lab.profileDir);
}
