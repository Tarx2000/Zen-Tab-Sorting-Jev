#!/usr/bin/env node
// Exercises the actual Sine-loaded mod in a disposable profile. No real AI calls.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConnectedProfile, delay, launchZen, stopZen } from "./zen-e2e-driver.mjs";
import { createLabProfile, findDefaultSineProfile, removeLabProfile, scenarioPrefs, writeUserPrefs } from "./zen-e2e-profile.mjs";
import { MarionetteClient, reserveTcpPort } from "./zen-e2e-marionette.mjs";
import { startFixturePageServer } from "./zen-e2e-servers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headed = process.argv.includes("--headed");
const keep = process.argv.includes("--keep-profile");
const drag = process.argv.includes("--drag");
const bulkArg = process.argv.indexOf("--tabs");
const bulkTabs = bulkArg >= 0 ? Number.parseInt(process.argv[bulkArg + 1], 10) : 0;
if (!Number.isInteger(bulkTabs) || bulkTabs < 0 || bulkTabs > 1000) throw new Error("--tabs must be between 0 and 1000");
const artifacts = process.env.ZEN_WORKSPACE_ARTIFACTS || "";
const lab = await createLabProfile(root, await findDefaultSineProfile());
const port = await reserveTcpPort();
const pages = await startFixturePageServer();
let zen;
let client;
const execute = async (script) => {
  const result = await client.executeAsync(`
    const done = arguments[arguments.length - 1];
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    (async () => { ${script} })().then(value => done({ value })).catch(error => done({ error: error.stack || error.message }));
  `);
  if (result?.error) throw new Error(result.error);
  return result?.value;
};

try {
  await writeUserPrefs(lab.profileDir, [
    ...scenarioPrefs({ scenario: "hybrid", providerPort: 1, marionettePort: port }),
    ["extensions.zen-auto-organize.ai-engine", "jev"],
    ["extensions.zen-auto-organize.ai-jev-api-key", "workspace-lab-only"],
    ["extensions.zen-auto-organize.skip-domains-json", JSON.stringify(["localhost"])],
    ["ui.prefersReducedMotion", 0],
    ["zen.view.sidebar-expanded", true],
    ["browser.startup.page", 0],
  ]);
  zen = launchZen({ options: { headed, zenBinary: process.env.ZEN_BINARY || "/Applications/Zen.app/Contents/MacOS/zen" }, profileDir: lab.profileDir, marionettePort: port });
  client = await MarionetteClient.connect(port);
  await client.newSession();
  await client.setScriptTimeout();
  await client.setChromeContext();
  await assertConnectedProfile(client, lab.profileDir);
  const deadline = Date.now() + 25000;
  let ready;
  do {
    ready = await execute(`return { ready: typeof win?.ZenTabSorting?.organizeWorkspaces === "function", menu: !!win?.document.getElementById("zao-sort-workspaces") };`);
    if (!ready.ready) await delay(250);
  } while (!ready.ready && Date.now() < deadline);
  assert.equal(ready.ready, true, `Mod did not initialize: ${JSON.stringify(ready)}`);
  assert.equal(ready.menu, true);
  console.log("workspace-e2e: Sine and workspace menu ready");
  const fixture = await execute(`
    const manager = win.gZenWorkspaces;
    const browser = win.gBrowser;
    const source = manager.getWorkspaces()[0];
    source.name = "SocialMedia";
    await manager.saveWorkspace(source);
    const target = await manager.createAndSaveWorkspace("Development", "💻");
    const generic = await manager.createAndSaveWorkspace("Space2", "○");
    await manager.changeWorkspaceWithID(source.uuid);
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const tab = (name, pinned = false, skip = false, userContextId = 0) => {
      const item = browser.addTab("http://" + (skip ? "localhost" : "127.0.0.1") + ":${pages.port}/" + encodeURIComponent(name), { inBackground: true, skipAnimation: true, triggeringPrincipal: principal, userContextId });
      item.setAttribute("label", name);
      item.setAttribute("data-lab-name", name);
      if (pinned) browser.pinTab(item);
      return item;
    };
    await manager.changeWorkspaceWithID(target.uuid);
    const existingShared = browser.addTabGroup([tab("Dev Existing Shared")], { label: "Shared Dev", color: "red", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    const background = browser.addTabGroup([tab("Social Background A"), tab("Social Background B")], { label: "Social Background", color: "purple", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    await manager.changeWorkspaceWithID(generic.uuid);
    const genericFolder = win.gZenFolders.createFolder([tab("Dev Generic Background")], { label: "Dev Generic Folder", workspaceId: generic.uuid, collapsed: true, saveOnWindowClose: true });
    await manager.changeWorkspaceWithID(source.uuid);
    const shared = browser.addTabGroup([tab("Dev Incoming Shared")], { label: "Shared Dev", color: "cyan", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    const normal = browser.addTabGroup([tab("Dev A"), tab("Dev B")], { label: "Dev Group", color: "blue", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    const { applyGroupColorStrength } = ChromeUtils.importESModule("chrome://sine/content/zen-tab-sorting/modules/group-appearance.mjs");
    applyGroupColorStrength(normal, 18);
    normal.collapsed = true;
    const parent = browser.addTabGroup([tab("Dev Parent")], { label: "Dev Parent", color: "orange", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    const child = browser.addTabGroup([tab("Dev Child")], { label: "Dev Child", color: "green", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    browser.zenHandleTabMove(child, () => parent.groupContainer.appendChild(child));
    const folder = win.gZenFolders.createFolder([tab("Dev Pinned A"), tab("Dev Pinned B")], { label: "Dev Folder", workspaceId: source.uuid, collapsed: true, saveOnWindowClose: true });
    const subfolder = win.gZenFolders.createFolder([tab("Dev Nested Pin")], { label: "Dev Subfolder", workspaceId: source.uuid });
    browser.zenHandleTabMove(subfolder, () => folder.groupContainer.appendChild(subfolder));
    const empty = win.gZenFolders.createFolder([], { label: "Dev Empty", workspaceId: source.uuid });
    const split = browser.addTabGroup([tab("Dev Split A"), tab("Dev Split B")], { label: "Dev Split", forSplitView: true, insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    const boundary = tab("Boundary");
    const broken = tab("Broken");
    const retry = tab("Retry");
    const moveRetry = tab("Dev MoveRetry");
    const moveBroken = tab("Dev MoveBroken");
    const pinned = tab("Dev Pinned Single", true);
    const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
    const identity = ContextualIdentityService.create("Workspace Lab", "briefcase", "blue");
    const containerTab = tab("Dev Container", false, false, identity.userContextId);
    const skip = browser.addTabGroup([tab("Dev Skipped", false, true), tab("Dev Kept With Skip")], { label: "Dev Skip Group", insertBefore: manager.activeWorkspaceElement.tabsContainer.firstChild });
    const active = tab("Dev Active");
    for (let i = 0; i < ${bulkTabs}; i++) tab("Dev Bulk " + i);
    browser.selectedTab = active;
    win.__workspaceLab = { source: source.uuid, target: target.uuid, generic: generic.uuid, background, genericFolder, normal, parent, child, folder, subfolder, empty, split, boundary, broken, retry, moveRetry, moveBroken, pinned, containerTab, containerId: identity.userContextId, originalBrowser: containerTab.linkedBrowser, shared, existingShared, skip, active, makeTab: tab };
    win.__workspaceLab.expected = [normal, parent, child, folder, subfolder, empty, split, shared, existingShared, skip].map(group => ({ node: group, id: group.id, collapsed: group.collapsed, label: group.label, color: group.color, members: [...group.querySelectorAll("tab")], parents: [...group.querySelectorAll("tab")].map(item => item.parentElement) }));
    manager.updateTabsContainers();
    return { source: source.uuid, target: target.uuid, generic: generic.uuid, units: browser.tabs.length };
  `);
  // Let page loads finish before taking the classification snapshot.
  await delay(1200);
  await execute(`for (const item of win.gBrowser.tabs) if (item.hasAttribute("data-lab-name")) item.setAttribute("label", item.getAttribute("data-lab-name"));`);
  if (drag) {
    let coords = await execute(`
      const s = win.__workspaceLab;
      s.parent.collapsed = true;
      s.skip.collapsed = true;
      s.normal.labelElement.scrollIntoView({ block: "center" });
      win.__dragChecks = [];
      win.document.addEventListener("dragover", (event) => {
        win.__workspaceLab.dragTransfer = event.dataTransfer;
        const edge = s.parent.labelContainerElement.hasAttribute("data-zao-edge-reorder");
        const hoveredGroup = event.target.closest?.("tab-group");
        const pointerY = event.clientY;
        const headerRect = event.target.closest?.(".tab-group-label-container")?.getBoundingClientRect();
        const inputTypes = [...event.dataTransfer.types];
        win.setTimeout(() => {
        const service = win.gBrowser.tabContainer.tabDragAndDrop;
        const ghost = service.originalDragImageArgs?.[0]?.querySelector("[drag-image]");
        const rect = ghost?.getBoundingClientRect();
        win.__dragChecks.push({ ghost: !!ghost, width: rect?.width, height: rect?.height,
          display: ghost ? win.getComputedStyle(ghost).display : "", label: ghost?.getAttribute("label"),
          edge, pointerY, headerTop: headerRect?.top, headerHeight: headerRect?.height, inputTypes, hovered: hoveredGroup?.getAttribute("label"), anyEdge: !!win.document.querySelector("[data-zao-edge-reorder]"),
          indicator: win.gZenPinnedTabManager._dragIndicator?.getAttribute("style") || "" });
      }, 0);
      }, true);
      await new Promise(resolve => win.setTimeout(resolve, 200));
      const source = s.normal.labelElement.getBoundingClientRect();
      const target = s.parent.labelContainerElement.getBoundingClientRect();
      return { x: Math.round(source.left + source.width / 2), y: Math.round(source.top + source.height / 2), tx: Math.round(target.left + target.width / 2), ty: Math.round(target.top + 2) };
    `);
    console.log(JSON.stringify({ dragCoordinates: coords }));
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const png = await client.command("WebDriver:TakeScreenshot", { full: true });
      await writeFile(resolve(artifacts, "before-drag.png"), Buffer.from(png, "base64"));
    }
    const pointer = async (actions) => client.command("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "lab-mouse", parameters: { pointerType: "mouse" }, actions }] });
    coords = await execute(`
      const source = win.__workspaceLab.normal.labelElement.getBoundingClientRect();
      return { x: Math.round(source.left + source.width / 2), y: Math.round(source.top + source.height / 2) };
    `);
    await pointer([{ type: "pointerMove", origin: "viewport", x: coords.x, y: coords.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", origin: "viewport", x: coords.x + 16, y: coords.y + 4, duration: 150 }]);
    const target = await execute(`const rect = win.__workspaceLab.parent.labelContainerElement.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 2) };`);
    coords.tx = target.x;
    coords.ty = target.y;
    await pointer([{ type: "pointerMove", origin: "viewport", x: coords.tx, y: coords.ty, duration: 200 }, { type: "pause", duration: 150 }]);
    // macOS WebDriver may include the custom titlebar inset in pointer origin.
    // Calibrate against the delivered DOM event rather than a fixed offset.
    for (let correction = 0; correction < 2; correction++) {
      const adjustment = await execute(`
        const last = win.__dragChecks.at(-1);
        const rect = win.__workspaceLab.parent.labelContainerElement.getBoundingClientRect();
        return { actualY: last?.pointerY, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 2) };
      `);
      const offset = Number.isFinite(adjustment.actualY) ? adjustment.actualY - coords.ty : 0;
      coords.ty = adjustment.y - offset;
      await pointer([{ type: "pointerMove", origin: "viewport", x: adjustment.x, y: coords.ty, duration: 80 }, { type: "pause", duration: 100 }]);
    }
    // Probe the exact header edge with the live native drag payload. This avoids
    // macOS OS-session pointer coalescing moving the probe back to row centre.
    const edgeProbe = await execute(`
      const header = win.__workspaceLab.parent.labelContainerElement;
      const rect = header.getBoundingClientRect();
      header.dispatchEvent(new win.DragEvent("dragover", { bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + 1,
        dataTransfer: win.__workspaceLab.dragTransfer }));
      const indicator = win.gZenPinnedTabManager._dragIndicator;
      return { edge: header.hasAttribute("data-zao-edge-reorder"), indicator: indicator?.getAttribute("style") || "", nearHeader: Math.abs(parseFloat(indicator?.style.getPropertyValue("--indicator-top")) - rect.top) <= 3 };
    `);
    const checks = await execute(`return win.__dragChecks;`);
    console.log(JSON.stringify({ drag: checks.slice(-4), dragEvents: checks.length }));
    await client.command("WebDriver:PerformActions", { actions: [{ type: "key", id: "lab-key", actions: [{ type: "keyDown", value: "\uE00C" }, { type: "keyUp", value: "\uE00C" }] }] });
    await client.command("WebDriver:ReleaseActions");
    assert.ok(checks.some(check => check.ghost && check.width > 10 && check.height > 10 && check.display !== "none"), "Native drag image must exist and have visible dimensions");
    assert.equal(edgeProbe.edge, true, "Native group edge targeting must activate");
    assert.equal(edgeProbe.nearHeader, true, "Native insertion marker must be at the hovered header");
    assert.ok(edgeProbe.indicator || checks.some(check => check.indicator), "Native insertion marker must be rendered");
    await delay(300);
    // Dragging may reorder root groups, but it must not alter membership.
    await execute(`win.__workspaceLab.expected.forEach(before => { before.collapsed = before.node.collapsed; });`);
  }
  const provider = await execute(`
    const state = win.__workspaceLab;
    const originalFetch = win.fetch;
    state.calls = [];
    state.tries = {};
    state.moveTries = {};
    state.folderTries = 0;
    const nativeFolderMove = win.gZenFolders.changeFolderToSpace;
    win.gZenFolders.changeFolderToSpace = function(folder, target, options) {
      if (folder === state.folder && ++state.folderTries === 1) {
        folder.tabs[0].setAttribute("zen-workspace-id", target);
        throw new Error("Simulated partial folder failure");
      }
      return nativeFolderMove.call(this, folder, target, options);
    };
    const nativeMove = win.gBrowser.zenHandleTabMove;
    win.gBrowser.zenHandleTabMove = function(node, ...args) {
      const name = node.getAttribute("data-lab-name");
      if ((name === "Dev MoveRetry" || name === "Dev MoveBroken") && node.getAttribute("zen-workspace-id") === state.source) {
        state.moveTries[name] = (state.moveTries[name] || 0) + 1;
        if (name === "Dev MoveBroken" || state.moveTries[name] === 1) throw new Error("Simulated native move failure");
      }
      return nativeMove.call(this, node, ...args);
    };
    win.fetch = async (url, request) => {
      if (!String(url).includes("api.typesafe.ai/v1/systemone") && !String(url).includes("openrouter.ai/api/alpha/decisions")) throw new Error("Unexpected provider call");
      const payload = JSON.parse(request.body);
      state.calls.push(payload.state.units.map(unit => unit.name));
      const answers = {};
      for (const [index, unit] of payload.state.units.entries()) {
        state.tries[unit.name] = (state.tries[unit.name] || 0) + 1;
        if (unit.name === "Broken" || (unit.name === "Retry" && state.tries[unit.name] === 1)) continue;
        const probabilities = { [state.source]: 0.1, [state.target]: 0.85, [state.generic]: 0.05 };
        if (unit.name === "Social Background") Object.assign(probabilities, { [state.source]: 0.85, [state.target]: 0.1 });
        if (unit.name === "Boundary") Object.assign(probabilities, { [state.source]: 0.40, [state.target]: 0.50, [state.generic]: 0.10 });
        answers["unit_" + index] = { choice: state.source, probabilities };
      }
      return new win.Response(JSON.stringify({ answers }));
    };
    return { intercepted: true };
  `);
  console.log(`workspace-e2e: fixture ready (${fixture.units} tabs)`);
  const duplicate = await execute(`
    win.__workspaceLab.animationFrames = [];
    win.__workspaceLab.frameTimer = win.setInterval(() => {
      const ghosts = [...win.document.querySelectorAll(".zao-sort-ghost")];
      if (ghosts.length) win.__workspaceLab.animationFrames.push(ghosts.map(node => ({ label: node.textContent, x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })));
    }, 16);
    win.__workspaceLab.promise = win.ZenTabSorting.organizeWorkspaces();
    return await win.ZenTabSorting.organizeWorkspaces();
  `);
  assert.equal(duplicate.busy, true);
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    for (let frame = 0; frame < 18; frame++) {
      const ongoing = await execute(`return { finished: win.ZenTabSortingLastWorkspaceRun?.finished, ghosts: win.document.querySelectorAll(".zao-sort-ghost").length };`);
      if (ongoing.finished) break;
      if (ongoing.ghosts) {
        const png = await client.command("WebDriver:TakeScreenshot", { full: true });
        await writeFile(resolve(artifacts, `animation-${frame}.png`), Buffer.from(png, "base64"));
      }
      await delay(40);
    }
  }
  const run = await execute(`const result = await win.__workspaceLab.promise; win.clearInterval(win.__workspaceLab.frameTimer); return result;`);
  console.log(JSON.stringify({ run: { ...run, moves: run.moves.length } }));
  const state = await execute(`
    const s = win.__workspaceLab;
    return {
      selectedPreserved: win.gBrowser.selectedTab === s.active,
      sameContainer: s.containerTab.userContextId === s.containerId && s.containerTab.linkedBrowser === s.originalBrowser,
      backgroundSpace: s.background.getAttribute("zen-workspace-id"),
      genericFolderSpace: s.genericFolder.getAttribute("zen-workspace-id"),
      sharedGroupsPreserved: s.shared !== s.existingShared && s.shared.isConnected && s.existingShared.isConnected && s.shared.parentElement === s.existingShared.parentElement,
      activeSpace: win.gZenWorkspaces.activeWorkspace,
      normalSpace: s.normal.getAttribute("zen-workspace-id"),
      pinnedSpace: s.pinned.getAttribute("zen-workspace-id"),
      boundarySpace: s.boundary.getAttribute("zen-workspace-id"),
      brokenSpace: s.broken.getAttribute("zen-workspace-id"),
      skipSpace: s.skip.querySelector("tab").getAttribute("zen-workspace-id"),
      emptySpace: s.empty.getAttribute("zen-workspace-id"),
      splitSpace: s.split.getAttribute("zen-workspace-id"),
      nestedGroupsPreserved: s.child.parentElement === s.parent.groupContainer && s.subfolder.parentElement === s.folder.groupContainer,
      groupStates: s.expected.map(before => ({ label: before.label, sameId: before.node.id === before.id, sameCollapsed: before.node.collapsed === before.collapsed, sameColor: before.node.color === before.color, sameTabs: before.members.every((tab, index) => before.node.querySelectorAll("tab")[index] === tab && tab.parentElement === before.parents[index]) })),
      tries: s.tries, calls: s.calls,
      moveTries: s.moveTries,
      folderTries: s.folderTries,
      animationFrames: s.animationFrames,
      hidden: win.document.querySelectorAll("[data-zao-in-flight]").length,
      busy: !!win._zaoSortSession,
      animation: win.ZenTabSortingLastAnimation,
    };
  `);
  console.log(JSON.stringify({ state: { ...state, tries: { Broken: state.tries.Broken, Retry: state.tries.Retry }, calls: state.calls.map(batch => batch.length), animationFrames: state.animationFrames.length } }));
  assert.equal(run.finished, true);
  assert.ok(run.moved >= 8);
  assert.equal(state.normalSpace, fixture.target);
  assert.equal(state.backgroundSpace, fixture.source);
  assert.equal(state.genericFolderSpace, fixture.target);
  assert.ok(run.kept >= 2, "Already-correct units in inactive Spaces must also be evaluated");
  assert.equal(state.pinnedSpace, fixture.target);
  assert.equal(state.emptySpace, fixture.target);
  assert.equal(state.splitSpace, fixture.target);
  assert.equal(state.boundarySpace, fixture.source);
  assert.equal(state.brokenSpace, fixture.source);
  assert.equal(state.skipSpace, fixture.source);
  assert.equal(state.nestedGroupsPreserved, true);
  assert.ok(state.groupStates.every((group) => group.sameId && group.sameCollapsed && group.sameColor && group.sameTabs));
  assert.equal(state.selectedPreserved, true);
  assert.equal(state.sameContainer, true);
  assert.equal(state.sharedGroupsPreserved, true);
  assert.equal(state.activeSpace, fixture.target);
  assert.equal(state.tries.Broken, 2);
  assert.equal(state.tries.Retry, 2);
  assert.equal(state.hidden, 0);
  assert.equal(state.busy, false);
  assert.equal(state.moveTries["Dev MoveRetry"], 2);
  assert.equal(state.moveTries["Dev MoveBroken"], 2);
  assert.equal(state.folderTries, 2);
  assert.equal(run.errors.length, 2);
  assert.match(run.errors.find(error => error.name === "Dev MoveBroken").reason, /Simulated native move failure/);
  assert.ok(state.animationFrames.length >= 2, "Animation must have multiple rendered frames");
  const positions = new Map();
  for (const frame of state.animationFrames) for (const ghost of frame) {
    if (!positions.has(ghost.label)) positions.set(ghost.label, new Set());
    positions.get(ghost.label).add(`${Math.round(ghost.x)},${Math.round(ghost.y)}`);
  }
  assert.ok([...positions.values()].some(values => values.size >= 3), "Ghosts must move across multiple visible positions");
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await writeFile(resolve(artifacts, "workspace-result.json"), JSON.stringify({ fixture, run, state }, null, 2));
    const png = await client.command("WebDriver:TakeScreenshot", { full: true });
    await writeFile(resolve(artifacts, "workspace-result.png"), Buffer.from(png, "base64"));
  }
  const edgeCases = await execute(`
    const state = win.__workspaceLab;
    await win.gZenWorkspaces.changeWorkspaceWithID(state.source);
    const race = win.gBrowser.addTabGroup([state.makeTab("Dev Race A")], { label: "Dev Race", insertBefore: win.gZenWorkspaces.activeWorkspaceElement.tabsContainer.firstChild });
    const reduced = state.makeTab("Dev Reduced");
    await new Promise(resolve => win.setTimeout(resolve, 250));
    let changed = false;
    win.fetch = async (url, request) => {
      if (!String(url).includes("/systemone")) throw new Error("Unexpected provider call");
      const payload = JSON.parse(request.body);
      if (!changed && payload.state.units.some(unit => unit.name === "Dev Race")) {
        changed = true;
        win.gBrowser.moveTabToExistingGroup(state.makeTab("User addition"), race);
      }
      const answers = {};
      for (const [index, unit] of payload.state.units.entries()) {
        const probabilities = Object.fromEntries(payload.state.spaces.map(space => [space.id, space.id === state.target ? 0.9 : 0.05]));
        if (unit.name === "Social Background") Object.assign(probabilities, { [state.source]: 0.9, [state.target]: 0.05 });
        answers["unit_" + index] = { probabilities, choice: state.target };
      }
      return new win.Response(JSON.stringify({ answers }));
    };
    Services.prefs.setIntPref("ui.prefersReducedMotion", 1);
    await new Promise(resolve => win.setTimeout(resolve, 100));
    const item = win.document.getElementById("zao-sort-workspaces");
    const popup = item.parentElement;
    popup.dispatchEvent(new win.Event("popupshowing"));
    const menuLabel = item.getAttribute("label");
    const previousRun = win.ZenTabSortingLastWorkspaceRun;
    item.doCommand();
    const deadline = Date.now() + 30000;
    while ((win.ZenTabSortingLastWorkspaceRun === previousRun || !win.ZenTabSortingLastWorkspaceRun.finished) && Date.now() < deadline) await new Promise(resolve => win.setTimeout(resolve, 25));
    return {
      menuLabel, finished: win.ZenTabSortingLastWorkspaceRun.finished,
      racePreserved: race.querySelectorAll("tab").length === 2 && race.closest("zen-workspace").id === state.source,
      raceReported: win.ZenTabSortingLastWorkspaceRun.errors.some(error => error.name === "Dev Race"),
      reducedMoved: reduced.getAttribute("zen-workspace-id") === state.target,
      reducedMotion: win.ZenTabSortingLastAnimation.reducedMotion,
      flights: win.ZenTabSortingLastAnimation.flyCount,
      hidden: win.document.querySelectorAll("[data-zao-in-flight]").length,
    };
  `);
  console.log(JSON.stringify({ edgeCases }));
  assert.equal(edgeCases.menuLabel, "Alle Spaces automatisch sortieren");
  assert.equal(edgeCases.finished, true);
  assert.equal(edgeCases.racePreserved, true);
  assert.equal(edgeCases.raceReported, true);
  assert.equal(edgeCases.reducedMoved, true);
  assert.equal(edgeCases.reducedMotion, true);
  assert.equal(edgeCases.flights, 0);
  assert.equal(edgeCases.hidden, 0);
  if (process.argv.includes("--restart")) {
    const saved = await execute(`
      const state = win.__workspaceLab;
      const groups = [state.normal, state.parent, state.child, state.folder, state.subfolder, state.empty, state.genericFolder];
      const snapshot = groups.map(group => ({ id: group.id, label: group.getAttribute("label"), space: group.getAttribute("zen-workspace-id"), parent: group.group?.id || null, collapsed: group.collapsed,
        colorStrength: group.getAttribute("data-zao-color-strength"), colorStyle: group.style.getPropertyValue("--zao-group-color-strength") }));
      Services.prefs.setStringPref("extensions.zen-auto-organize.new-group-color-strength", "80");
      await Promise.all(win.gZenWorkspaces.allStoredTabs.map(tab => tab.linkedBrowser ? win.gBrowser.TabStateFlusher.flush(tab.linkedBrowser) : Promise.resolve()));
      Services.prefs.setIntPref("browser.startup.page", 3);
      Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", true);
      win.setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 100);
      return snapshot;
    `);
    assert.equal(saved[0].colorStrength, "18");
    assert.equal(saved[0].colorStyle, "18%");
    assert.equal(saved[1].colorStrength, null);
    client.close();
    client = null;
    const quitDeadline = Date.now() + 5000;
    while (zen.exitCode === null && Date.now() < quitDeadline) await delay(50);
    await stopZen(zen);
    const nextPort = await reserveTcpPort();
    await writeUserPrefs(lab.profileDir, [
      ...scenarioPrefs({ scenario: "hybrid", providerPort: 1, marionettePort: nextPort }),
      ["browser.startup.page", 3], ["browser.sessionstore.resume_session_once", true],
      ["extensions.zen-auto-organize.new-group-color-strength", "80"],
    ]);
    zen = launchZen({ options: { headed, zenBinary: process.env.ZEN_BINARY || "/Applications/Zen.app/Contents/MacOS/zen" }, profileDir: lab.profileDir, marionettePort: nextPort });
    client = await MarionetteClient.connect(nextPort);
    await client.newSession();
    await client.setScriptTimeout();
    await client.setChromeContext();
    await assertConnectedProfile(client, lab.profileDir);
    let restored;
    const restoreDeadline = Date.now() + 20000;
    do {
      restored = await execute(`return ${JSON.stringify(saved)}.map(before => {
        const group = win.document.getElementById(before.id);
        return { ...before, found: !!group, correctSpace: group?.getAttribute("zen-workspace-id") === before.space, correctParent: (group?.group?.id || null) === before.parent, correctCollapsed: group?.collapsed === before.collapsed,
          correctColorStrength: group?.getAttribute("data-zao-color-strength") === before.colorStrength && group?.style.getPropertyValue("--zao-group-color-strength") === before.colorStyle };
      });`);
      if (restored.every(group => group.found && group.correctSpace && group.correctParent && group.correctCollapsed && group.correctColorStrength)) break;
      await delay(250);
    } while (Date.now() < restoreDeadline);
    console.log(JSON.stringify({ restored }));
    assert.ok(restored.every(group => group.found && group.correctSpace && group.correctParent && group.correctCollapsed && group.correctColorStrength), "Transferred group state and captured color strength must survive browser restart");
    assert.equal(await execute(`return Services.prefs.getStringPref("extensions.zen-auto-organize.new-group-color-strength");`), "80");
  }
  console.log("workspace-e2e: PASS native atomic groups/folders/splits, pins, strict margin, retry, partial errors and focus");
} catch (error) {
  console.error(`workspace-e2e: ${error.stack || error.message}`);
  if (zen) console.error(zen.e2eLogTail().join("\n"));
  process.exitCode = 1;
} finally {
  client?.close();
  if (zen) await stopZen(zen);
  await pages.close();
  if (!keep) await removeLabProfile(lab.profileDir);
  else console.log(`workspace-e2e: retained profile ${lab.profileDir}`);
}
