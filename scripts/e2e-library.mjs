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
        await new Promise(resolve => win.setTimeout(resolve, 850));
        return new win.Response(JSON.stringify({ output_text: JSON.stringify({ "0": s.groupName || "Library Design", "1": s.groupName || "Library Design" }) }));
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
    Services.prefs.setIntPref("ui.prefersReducedMotion", 0);
    card.querySelector('[id^="tab-wand-button"]').click();
  `);
  await waitFor(`return win.__libraryLab.providerCalls > 0 && !!win._zaoSortSession;`);
  const loading = await execute(`
    const section = win.document.querySelector("zen-library-spaces-section");
    section.refreshStripsNow();
    await new Promise(resolve => win.setTimeout(resolve, 50));
    const button = [...section.querySelectorAll(".zen-library-space")].find(card => card.dataset.uuid === win.__libraryLab.target).querySelector('[data-zao-library-organize]');
    const other = [...section.querySelectorAll('[data-zao-library-organize]')].filter(node => node !== button);
    const ring = button.querySelector(".zao-loading-icon");
    return { busy: button.getAttribute("aria-busy"), disabled: button.disabled,
      othersIdle: other.every(node => node.getAttribute("aria-busy") === "false"),
      ringOpacity: getComputedStyle(ring).opacity,
      rotating: ring.querySelector("path").getAnimations().some(animation => animation.playState === "running") };
  `);
  console.log(JSON.stringify({ loading }));
  assert.equal(loading.busy, "true");
  assert.equal(loading.disabled, true);
  assert.equal(loading.othersIdle, true);
  assert.equal(loading.rotating, true);
  await waitFor(`return win.__libraryLab.providerCalls > 0 && !win._zaoSortSession;`);
  const state = await execute(`
    const s = win.__libraryLab;
    const card = [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].find(card => card.dataset.uuid === s.target);
    const session = JSON.parse(Services.prefs.getStringPref("extensions.zen-auto-organize.ai-chatgpt-session-json"));
    s.initialColorGroup = s.tabs[0].group;
    s.initialColor = { strength: s.initialColorGroup.getAttribute("data-zao-color-strength"),
      normal: s.initialColorGroup.style.getPropertyValue("--zao-group-color-strength"),
      hover: s.initialColorGroup.style.getPropertyValue("--zao-group-hover-strength") };
    const copy = card.querySelector('tab-group[label="Library Design"]');
    return { tokenCalls: s.tokenCalls, providerCalls: s.providerCalls, rotationSaved: session.refreshToken === "test-rotation-2",
      sourcePreserved: win.gZenWorkspaces.activeWorkspace === s.source && win.gBrowser.selectedTab === s.originalTab,
      realGrouped: s.tabs.every(tab => tab.closest("tab-group")?.label === "Library Design" && tab.getAttribute("zen-workspace-id") === s.target),
      initialColor: s.initialColor, copyStrength: copy?.getAttribute("data-zao-color-strength"),
      copyColor: copy?.style.getPropertyValue("--zao-group-color-strength"),
      copyGrouped: !!copy, visible: (() => { const rect = card.querySelector('[id^="tab-wand-button"]').getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })(), count: card.querySelectorAll('[id^="tab-wand-button"]').length };
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
  assert.equal(await execute(`return [...win.document.querySelectorAll('.zao-organize-button')].every(button => button.getAttribute('aria-busy') === 'false' && !button.disabled);`), true);
  assert.deepEqual(state.initialColor, { strength: "20", normal: "20%", hover: "26%" });
  assert.equal(state.copyStrength, "20");
  assert.equal(state.copyColor, "20%");
  if (process.env.ZEN_LIBRARY_SCREENSHOT) {
    const png = await client.command("WebDriver:TakeScreenshot", { full: true });
    await writeFile(process.env.ZEN_LIBRARY_SCREENSHOT, Buffer.from(png.value || png, "base64"));
  }
  // Native refresh creates fresh copies; their command activation must still
  // route once to the same real Space and reuse the saved access token.
  await execute(`
    const s = win.__libraryLab;
    Services.prefs.setStringPref("extensions.zen-auto-organize.new-group-color-strength", "60");
    Services.prefs.setStringPref("extensions.zen-auto-organize.ai-sort-mode", "hybrid");
    const manager = win.gZenWorkspaces;
    await manager.changeWorkspaceWithID(s.target);
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    s.newColorTabs = [0, 1].map(index => win.gBrowser.addTab("http://127.0.0.1:${pages.port}/color-sixty-" + index,
      { inBackground: true, triggeringPrincipal: principal }));
    await new Promise(resolve => win.setTimeout(resolve, 200));
    await manager.changeWorkspaceWithID(s.source);
    win.gBrowser.selectedTab = s.originalTab;
    s.groupName = "Library Sixty";
    win.document.querySelector("zen-library-spaces-section").refreshStripsNow();
    await new Promise(resolve => win.setTimeout(resolve, 100));
    const card = [...win.document.querySelectorAll(".zen-library-space[data-uuid]")].find(card => card.dataset.uuid === win.__libraryLab.target);
    if (card.querySelectorAll('[id^="tab-wand-button"]').length !== 1) throw new Error("Duplicate after native refresh");
    card.querySelector('[id^="tab-wand-button"]').dispatchEvent(new win.Event("command", { bubbles: true, cancelable: true }));
  `);
  await waitFor(`return win.__libraryLab.providerCalls === 2 && !win._zaoSortSession;`);
  assert.equal(await execute(`return win.__libraryLab.tokenCalls;`), 1);
  assert.equal(await execute(`return win.gZenWorkspaces.activeWorkspace === win.__libraryLab.source;`), true);
  const newColor = await execute(`
    const s = win.__libraryLab;
    const group = s.newColorTabs[0].group;
    const copy = win.document.querySelector("zen-library-spaces-section").copyForTab(s.newColorTabs[0])?.closest("tab-group");
    return { name: group?.label, strength: group?.getAttribute("data-zao-color-strength"),
      normal: group?.style.getPropertyValue("--zao-group-color-strength"),
      hover: group?.style.getPropertyValue("--zao-group-hover-strength"),
      copyStrength: copy?.getAttribute("data-zao-color-strength"), copyColor: copy?.style.getPropertyValue("--zao-group-color-strength"),
      previousRetained: s.initialColorGroup.isConnected && s.tabs.every(tab => tab.group === s.initialColorGroup),
      previousColor: { strength: s.initialColorGroup.getAttribute("data-zao-color-strength"),
        normal: s.initialColorGroup.style.getPropertyValue("--zao-group-color-strength"), hover: s.initialColorGroup.style.getPropertyValue("--zao-group-hover-strength") } };
  `);
  console.log(JSON.stringify({ newColor }));
  assert.equal(newColor.name, "Library Sixty");
  assert.equal(newColor.strength, "60");
  assert.equal(newColor.normal, "60%");
  assert.equal(newColor.hover, "78%");
  assert.equal(newColor.copyStrength, "60");
  assert.equal(newColor.copyColor, "60%");
  assert.equal(newColor.previousRetained, true);
  assert.deepEqual(newColor.previousColor, state.initialColor);
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
  // Native Library refreshes copy every attribute from the live strip. A copy
  // rebuilt during a flight must not inherit a permanent hidden state.
  const transfers = await execute(`
    const s = win.__libraryLab;
    const manager = win.gZenWorkspaces;
    const section = win.document.querySelector("zen-library-spaces-section");
    Services.prefs.setIntPref("ui.prefersReducedMotion", 0);
    Services.prefs.setStringPref("extensions.zen-auto-organize.ai-jev-api-key", "library-lab-only");
    await new Promise(resolve => win.setTimeout(resolve, 100));
    const group = win.gBrowser.addTabGroup(s.tabs, { label: "Library Transfer Group", color: "blue",
      insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    if (group.hasAttribute("data-zao-color-strength")) throw new Error("Manual native group must remain unmarked");
    group.collapsed = false;
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const pinned = win.gBrowser.addTab("http://127.0.0.1:${pages.port}/library-pin", { inBackground: true, triggeringPrincipal: principal });
    pinned.setAttribute("label", "Library Transfer Pin");
    const folder = win.gZenFolders.createFolder([pinned], { label: "Library Transfer Folder", workspaceId: s.target, collapsed: false });
    await new Promise(resolve => win.setTimeout(resolve, 250));
    const originals = [...manager.allStoredTabs].filter(tab => !tab.hasAttribute("zen-empty-tab"));
    const browsers = originals.map(tab => tab.linkedBrowser);
    await manager.changeWorkspaceWithID(s.source);
    win.gBrowser.selectedTab = s.originalTab;
    let destination = s.source;
    win.fetch = async (url, request) => {
      if (!String(url).includes("/systemone")) throw new Error("Unexpected Library transfer provider");
      const payload = JSON.parse(request.body);
      const answers = Object.fromEntries(payload.state.units.map((unit, index) => ["unit_" + index, {
        choice: destination, probabilities: Object.fromEntries(payload.state.spaces.map(space => [space.id, space.id === destination ? 0.95 : 0.05])),
      }]));
      return new win.Response(JSON.stringify({ answers }));
    };
    const runs = [];
    for (const [index, reduced] of [false, true, false].entries()) {
      const failedMove = index === 2;
      destination = reduced ? s.target : s.source;
      Services.prefs.setIntPref("ui.prefersReducedMotion", reduced ? 1 : 0);
      const library = win.document.querySelector("zen-library");
      if (!library.constructor.isLibrarySlightlyOpen) library.constructor.toggle("spaces");
      await new Promise(resolve => win.setTimeout(resolve, 400));
      const destinationCard = [...section.querySelectorAll(".zen-library-space")].find(card => card.dataset.uuid === destination);
      destinationCard.scrollIntoView({ inline: "center", block: "nearest" });
      let refreshedDuringMotion = false;
      let transientMarkers = false;
      let sidebarGhosts = false;
      let nativeEntrances = 0;
      let entranceFrames = 0;
      let flightFrames = 0;
      let refreshedDuringFlight = false;
      let persistedAfterRefresh = false;
      const nativeElementAnimate = win.gZenUIManager.elementAnimate;
      win.gZenUIManager.elementAnimate = function(node, frames, ...args) {
        if (frames.opacity?.[0] === 0.65) nativeEntrances++;
        return nativeElementAnimate.call(this, node, frames, ...args);
      };
      let moveAttempts = 0;
      const previousGroupSpace = group.getAttribute("zen-workspace-id");
      const nativeMove = win.gBrowser.zenHandleTabMove;
      if (failedMove) win.gBrowser.zenHandleTabMove = function(node, ...args) {
        if (node === group) { moveAttempts++; throw new Error("Simulated Library group move failure"); }
        return nativeMove.call(this, node, ...args);
      };
      const timer = win.setInterval(() => {
        transientMarkers ||= !!win.document.querySelector("[data-zao-in-flight]");
        sidebarGhosts ||= !!win.document.querySelector(".zao-sort-ghost, .zao-sort-animation-layer");
        const flight = win.document.querySelector('.zao-library-flight');
        if (flight) {
          flightFrames++;
          if (!refreshedDuringFlight) {
            section.refreshStripsNow();
            refreshedDuringFlight = true;
            persistedAfterRefresh = flight.isConnected && flight.getAnimations().some(animation => animation.playState === 'running');
          }
        }
        entranceFrames += [...section.querySelectorAll("tab, .tab-group-label-container")]
          .filter(node => node.getAnimations().some(animation => animation.effect?.getKeyframes().some(frame => Number(frame.opacity) === 0.65))).length;
        if (!refreshedDuringMotion && win.ZenTabSortingLastAnimation?.surface === "library" && !win.ZenTabSortingLastAnimation.finished) {
          refreshedDuringMotion = true;
          section.refreshStripsNow();
        }
      }, 16);
      let run;
      try { run = await win.ZenTabSorting.organizeWorkspaces(); }
      finally {
        win.clearInterval(timer);
        win.gBrowser.zenHandleTabMove = nativeMove;
        win.gZenUIManager.elementAnimate = nativeElementAnimate;
      }
      await new Promise(resolve => win.setTimeout(resolve, 150));
      const copies = originals.map(tab => section.copyForTab(tab));
      for (const copy of copies) {
        for (let parent = copy?.parentElement; parent && parent !== section; parent = parent.parentElement) {
          if (parent.matches("tab-group, zen-folder")) parent.collapsed = false;
        }
      }
      await new Promise(resolve => win.setTimeout(resolve, 300));
      runs.push({ reduced, failedMove, moveAttempts, moved: run.moved, errors: run.errors.length, refreshedDuringMotion,
        transientMarkers, sidebarGhosts, nativeEntrances, entranceFrames, flightFrames, refreshedDuringFlight, persistedAfterRefresh,
        layersAfter: win.document.querySelectorAll('.zao-library-flight, .zao-library-animation-layer').length,
        animation: win.ZenTabSortingLastAnimation,
        libraryOpen: library.constructor.isLibraryOpen,
        sameTabs: originals.every((tab, index) => tab.isConnected && tab.linkedBrowser === browsers[index]),
        correctSpaces: originals.every(tab => tab.getAttribute("zen-workspace-id") ===
          (failedMove && s.tabs.includes(tab) ? previousGroupSpace : destination)),
        grouped: s.tabs.every(tab => tab.group === group) && pinned.closest("zen-folder") === folder,
        realCount: manager.allStoredTabs.filter(tab => !tab.hasAttribute("zen-empty-tab")).length,
        expectedCount: originals.length,
        copyCount: copies.filter(Boolean).length,
        copiesVisible: copies.every(copy => copy && win.getComputedStyle(copy).visibility !== "hidden" && !copy.closest('[data-zao-in-flight]')),
        leakedMarkers: section.querySelectorAll("[data-zao-in-flight]").length,
      });
    }
    return runs;
  `);
  console.log(JSON.stringify({ transfers }));
  for (const transfer of transfers) {
    assert.ok(transfer.moved >= (transfer.failedMove ? 1 : 2));
    assert.equal(transfer.errors, transfer.failedMove ? 1 : 0);
    assert.equal(transfer.moveAttempts, transfer.failedMove ? 2 : 0);
    assert.equal(transfer.animation.surface, "library");
    assert.equal(transfer.animation.nativeRefresh, true);
    assert.equal(transfer.layersAfter, 0);
    assert.equal(transfer.transientMarkers, false);
    assert.equal(transfer.sidebarGhosts, false);
    if (!transfer.reduced) {
      assert.equal(transfer.refreshedDuringMotion, true, "Regression must refresh native Library copies during native motion");
      assert.ok(transfer.nativeEntrances + transfer.animation.flyCount > 0, "Incoming rows must animate");
      assert.ok(transfer.entranceFrames + transfer.flightFrames > 0, "Motion must render frames");
      if (transfer.animation.flyCount) {
        assert.equal(transfer.refreshedDuringFlight, true);
        assert.equal(transfer.persistedAfterRefresh, true);
      }
    } else {
      assert.equal(transfer.nativeEntrances, 0);
      assert.equal(transfer.animation.flyCount, 0);
    }
    assert.equal(transfer.sameTabs, true);
    assert.equal(transfer.libraryOpen, true);
    assert.equal(transfer.correctSpaces, true);
    assert.equal(transfer.grouped, true);
    assert.equal(transfer.realCount, transfer.expectedCount);
    assert.equal(transfer.copyCount, transfer.expectedCount);
    assert.equal(transfer.copiesVisible, true);
    assert.equal(transfer.leakedMarkers, 0);
  }
  const interrupted = await execute(`
    const s = win.__libraryLab;
    const manager = win.gZenWorkspaces;
    const section = win.document.querySelector("zen-library-spaces-section");
    const originals = [...manager.allStoredTabs].filter(tab => !tab.hasAttribute("zen-empty-tab"));
    const browsers = originals.map(tab => tab.linkedBrowser);
    win.fetch = async (url, request) => {
      if (!String(url).includes("/systemone")) throw new Error("Unexpected interruption provider");
      const payload = JSON.parse(request.body);
      return new win.Response(JSON.stringify({ answers: Object.fromEntries(payload.state.units.map((unit, index) =>
        ["unit_" + index, { choice: s.target, probabilities: Object.fromEntries(payload.state.spaces.map(space => [space.id, space.id === s.target ? 0.95 : 0.05])) }])) }));
    };
    const nativeMove = win.gZenFolders.changeFolderToSpace;
    win.gZenFolders.changeFolderToSpace = function(...args) {
      const result = nativeMove.apply(this, args);
      win._zaoSortSession.controller.abort();
      return result;
    };
    let run;
    try { run = await win.ZenTabSorting.organizeWorkspaces(); }
    finally { win.gZenFolders.changeFolderToSpace = nativeMove; }
    await new Promise(resolve => win.setTimeout(resolve, 150));
    return { errors: run.errors.map(error => error.reason), finished: run.finished,
      animation: win.ZenTabSortingLastAnimation,
      sameTabs: originals.every((tab, index) => tab.isConnected && tab.linkedBrowser === browsers[index]),
      copiesPresent: originals.every(tab => section.copyForTab(tab)),
      hiddenMarkers: win.document.querySelectorAll("[data-zao-in-flight], .zao-sort-ghost").length,
      busy: !!win._zaoSortSession };
  `);
  console.log(JSON.stringify({ interrupted }));
  assert.ok(interrupted.errors.some(reason => /abgebrochen/.test(reason)));
  assert.equal(interrupted.finished, true);
  assert.equal(interrupted.animation.surface, "library");
  assert.equal(interrupted.animation.nativeRefresh, true);
  assert.equal(interrupted.animation.finished, true);
  assert.equal(interrupted.sameTabs, true);
  assert.equal(interrupted.copiesPresent, true);
  assert.equal(interrupted.hiddenMarkers, 0);
  assert.equal(interrupted.busy, false);
  const presentationEdges = await execute(`
    const s = win.__libraryLab;
    const manager = win.gZenWorkspaces;
    const section = win.document.querySelector('zen-library-spaces-section');
    const originals = [...manager.allStoredTabs].filter(tab => !tab.hasAttribute('zen-empty-tab'));
    const browsers = originals.map(tab => tab.linkedBrowser);
    const results = [];
    for (const [index, mode] of ['scroll', 'close', 'stalled-helper', 'broken-snapshot'].entries()) {
      const destination = index % 2 === 1 ? s.source : s.target;
      const library = win.document.querySelector('zen-library');
      if (!library.constructor.isLibrarySlightlyOpen) library.constructor.toggle('spaces');
      await new Promise(resolve => win.setTimeout(resolve, 400));
      win.fetch = async (url, request) => {
        const payload = JSON.parse(request.body);
        return new win.Response(JSON.stringify({ answers: Object.fromEntries(payload.state.units.map((unit, i) =>
          ['unit_' + i, { choice: destination, probabilities: Object.fromEntries(payload.state.spaces.map(space =>
            [space.id, space.id === destination ? 0.95 : 0.05])) }])) }));
      };
      const helper = win.gZenUIManager.elementAnimate;
      const realElementFor = section.realElementFor;
      let brokenReads = 0;
      if (mode === 'broken-snapshot') section.realElementFor = function() { brokenReads++; throw new Error('Simulated incompatible Library reader'); };
      if (mode === 'stalled-helper') win.gZenUIManager.elementAnimate = function(node, ...args) {
        if (node.classList.contains('zao-library-flight')) return new Promise(() => {});
        return helper.call(this, node, ...args);
      };
      let triggered = false;
      const timer = win.setInterval(() => {
        if (triggered || !win.document.querySelector('.zao-library-flight')) return;
        triggered = true;
        if (mode === 'scroll') section.dispatchEvent(new win.Event('scroll'));
        if (mode === 'close') library.constructor.toggle('spaces');
      }, 8);
      const start = Date.now();
      let run;
      try { run = await win.ZenTabSorting.organizeWorkspaces(); }
      finally { win.clearInterval(timer); win.gZenUIManager.elementAnimate = helper; section.realElementFor = realElementFor; }
      if (mode === 'close') {
        // Closed native Library strips are intentionally cleared/hidden. Prove
        // that reopening rebuilds visible copies from unchanged real tabs.
        if (library.constructor.isLibrarySlightlyOpen) await new Promise(resolve => win.setTimeout(resolve, 400));
        library.constructor.toggle('spaces');
        await new Promise(resolve => win.setTimeout(resolve, 400));
        section.refreshStripsNow();
      }
      results.push({ mode, triggered: triggered || brokenReads > 0, elapsed: Date.now() - start, errors: run.errors.length, moved: run.moved,
        animation: win.ZenTabSortingLastAnimation,
        visible: originals.every(tab => { const copy = section.copyForTab(tab); return copy && win.getComputedStyle(copy).visibility !== 'hidden'; }),
        sameTabs: originals.every((tab, i) => tab.isConnected && tab.linkedBrowser === browsers[i]),
        clean: !win.document.querySelector('.zao-library-animation-layer, .zao-library-flight, [data-zao-in-flight]'),
        idle: !win._zaoSortSession && [...win.document.querySelectorAll('.zao-organize-button')].every(button => button.getAttribute('aria-busy') === 'false') });
    }
    return results;
  `);
  console.log(JSON.stringify({ presentationEdges }));
  for (const edge of presentationEdges) {
    assert.equal(edge.triggered, true, `must exercise ${edge.mode} during a flight`);
    assert.ok(edge.moved > 0);
    assert.equal(edge.errors, 0);
    assert.equal(edge.sameTabs, true);
    assert.equal(edge.visible, true);
    assert.equal(edge.clean, true);
    assert.equal(edge.idle, true);
    assert.equal(edge.animation.finished, true);
    if (edge.mode === 'broken-snapshot') assert.equal(edge.animation.presentationFailed, true);
    else if (edge.mode !== 'stalled-helper') assert.equal(edge.animation.cancelled, true);
    else assert.ok(edge.elapsed < 2500, 'A non-resolving native helper must be bounded');
  }
  if (process.env.ZEN_LIBRARY_FLIGHT_SCREENSHOT) {
    await execute(`
      const s = win.__libraryLab;
      win.fetch = async (url, request) => {
        const payload = JSON.parse(request.body);
        return new win.Response(JSON.stringify({ answers: Object.fromEntries(payload.state.units.map((unit, i) =>
          ['unit_' + i, { choice: s.target, probabilities: Object.fromEntries(payload.state.spaces.map(space =>
            [space.id, space.id === s.target ? 0.95 : 0.05])) }])) }));
      };
      win.__libraryVisualRun = win.ZenTabSorting.organizeWorkspaces();
    `);
    await waitFor(`return !!win.document.querySelector('.zao-library-flight');`);
    const png = await client.command('WebDriver:TakeScreenshot', { full: true });
    await writeFile(process.env.ZEN_LIBRARY_FLIGHT_SCREENSHOT, Buffer.from(png, 'base64'));
    await execute(`await win.__libraryVisualRun; delete win.__libraryVisualRun;`);
  }
  console.log("library-e2e: PASS single functional card icon, target scope, OAuth recovery, and visible cross-Space copies during native refresh, reduced motion and failed moves");
} finally {
  try { await client?.quit(); } catch {}
  await stopZen(zen);
  await pages.close();
  await removeLabProfile(lab.profileDir);
}
