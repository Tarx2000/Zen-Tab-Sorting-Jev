#!/usr/bin/env node
// Render the real Sine settings page in an isolated profile. No provider calls.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConnectedProfile, delay, launchZen, stopZen } from "./zen-e2e-driver.mjs";
import { createLabProfile, findDefaultSineProfile, removeLabProfile, scenarioPrefs, writeUserPrefs } from "./zen-e2e-profile.mjs";
import { MarionetteClient, reserveTcpPort } from "./zen-e2e-marionette.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lab = await createLabProfile(root, await findDefaultSineProfile());
const port = await reserveTcpPort();
let zen, client;
const execute = async script => {
  const result = await client.executeAsync(`const done = arguments[arguments.length - 1];
    (async () => { ${script} })().then(value => done({ value })).catch(error => done({ error: String(error) + "\\n" + error.stack }));`);
  if (result?.error) throw new Error(result.error);
  return result?.value;
};
const waitFor = async script => {
  const end = Date.now() + 25000;
  do { const result = await execute(script); if (result) return result; await delay(150); } while (Date.now() < end);
  console.log(await execute(`return { url: location.href, ready: document.readyState, sine: !!document.getElementById("sineModsList"), text: document.body?.textContent?.slice(-500) };`));
  throw new Error(`Timed out: ${script}`);
};
try {
  await writeUserPrefs(lab.profileDir, [
    ...scenarioPrefs({ scenario: "hybrid", providerPort: 1, marionettePort: port }),
    ["extensions.zen-auto-organize.ai-engine", "primalabs"],
    ["extensions.zen-auto-organize.ai-jev-api-key", "settings-test-only"],
  ]);
  zen = launchZen({ options: { headed: process.argv.includes("--headed"), zenBinary: process.env.ZEN_BINARY || "/Applications/Zen.app/Contents/MacOS/zen" }, profileDir: lab.profileDir, marionettePort: port });
  client = await MarionetteClient.connect(port);
  await client.newSession();
  await client.setScriptTimeout();
  await client.setChromeContext();
  await assertConnectedProfile(client, lab.profileDir);
  await waitFor(`return !!Services.wm.getMostRecentWindow("navigator:browser").ZenTabSorting;`);
  await execute(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const tab = win.gBrowser.addTab("about:preferences#sineMods", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = tab;
  `);
  await client.command("Marionette:SetContext", { value: "content" });
  const handles = await client.command("WebDriver:GetWindowHandles");
  await client.command("WebDriver:SwitchToWindow", { name: handles.at(-1) });
  console.log(JSON.stringify({ url: await execute(`return location.href;`) }));
  await waitFor(`return !!document.querySelector('.sineItem[mod-id="zen-tab-sorting"]');`);
  console.log("settings-e2e: Sine mod settings loaded");
  const structure = await execute(`
    const item = document.querySelector('.sineItem[mod-id="zen-tab-sorting"]');
    const dialog = item.querySelector(".sineItemPreferenceDialog");
    dialog.showModal();
    return { title: item.querySelector(".sineItemTitle")?.textContent, fields: dialog.querySelectorAll("hbox[id]").length };
  `);
  console.log(JSON.stringify(structure));
  await waitFor(`return document.querySelectorAll('.zao-settings-card').length >= 8;`);
  console.log("settings-e2e: layout ready");
} finally {
  try { await client?.quit(); } catch {}
  await stopZen(zen);
  await removeLabProfile(lab.profileDir);
}
