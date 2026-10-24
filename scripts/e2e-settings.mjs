#!/usr/bin/env node
// Render the real Sine settings page in an isolated profile. No provider calls.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
  await client.command("Marionette:SetContext", { value: "content" });
  await client.command("WebDriver:Navigate", { url: "about:preferences#sineMods" });
  await waitFor(`return !!document.querySelector('.sineItem[mod-id="zen-tab-sorting"]');`);
  console.log("settings-e2e: Sine mod settings loaded");
  await execute(`
    if (typeof window.gotoPref === "function") window.gotoPref("paneSineMods");
    else document.getElementById("category-sine-mods").click();
    await new Promise(resolve => setTimeout(resolve, 250));
  `);
  const structure = await execute(`
    const item = document.querySelector('.sineItem[mod-id="zen-tab-sorting"]');
    const dialog = item.querySelector(".sineItemPreferenceDialog");
    dialog.showModal();
    return { title: item.querySelector(".sineItemTitle")?.textContent, fields: dialog.querySelectorAll("hbox[id]").length };
  `);
  console.log(JSON.stringify(structure));
  await waitFor(`return document.querySelectorAll('.zao-settings-card').length >= 8;`);
  const properties = JSON.parse(await readFile(resolve(root, "preferences.json"), "utf8")).filter(entry => entry.property).map(entry => entry.property);
  const initial = await execute(`
    const d = document.querySelector('.sineItem[mod-id="zen-tab-sorting"] dialog');
    const row = name => d.querySelector("#" + name.replaceAll(".", "-"));
    return { visible: d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().height > 200, complete: ${JSON.stringify(properties)}.every(name => !!row(name)),
      oldEngine: !!row("extensions.zen-auto-organize.ai-engine"),
      provider: row("extensions.zen-auto-organize.ai-fallback-provider").querySelector("menulist").getAttribute("value"),
      keyMasked: row("extensions.zen-auto-organize.ai-jev-api-key").querySelector("input").type === "password",
      advancedClosed: [...d.querySelectorAll("details")].every(node => !node.open),
      jevTest: !!d.querySelector('[data-zao-section="jev"] .zao-jev-test'),
      llmTest: !!d.querySelector('[data-zao-section="llm"] .zao-llm-test'),
      localStyle: document.querySelector('style[data-zao-style]')?.textContent.includes("zao-settings-layout") };
  `);
  console.log(JSON.stringify({ initial }));
  for (const key of ["visible", "complete", "keyMasked", "advancedClosed", "jevTest", "llmTest", "localStyle"]) assert.equal(initial[key], true, key);
  assert.equal(initial.oldEngine, false);
  assert.equal(initial.provider, "primalabs");
  const strengthControl = await execute(`
    const row = document.getElementById("extensions-zen-auto-organize-new-group-color-strength");
    const input = row.querySelector("input");
    const initial = { type: input.type, value: input.value, output: row.querySelector("output").textContent };
    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (row.querySelector("output").textContent !== "42%") throw new Error("Color strength output did not follow slider");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return initial;
  `);
  assert.deepEqual(strengthControl, { type: "range", value: "20", output: "20%" });
  const cases = { chatgpt: "ai-chatgpt-model", primalabs: "ai-primalabs-model", openai: "ai-openai-model", gemini: "ai-gemini-model", ollama: "ai-ollama-model", custom: "ai-custom-model" };
  for (const [provider, field] of Object.entries(cases)) {
    const result = await execute(`
      const d = document.querySelector('.sineItem[mod-id="zen-tab-sorting"] dialog');
      const menu = d.querySelector("#extensions-zen-auto-organize-ai-fallback-provider menulist");
      menu.setAttribute("value", ${JSON.stringify(provider)});
      menu.dispatchEvent(new Event("command", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
      const models = ${JSON.stringify(Object.values(cases))};
      const visible = models.filter(name => getComputedStyle(d.querySelector("#extensions-zen-auto-organize-" + name)).display !== "none");
      return { visible, chat: getComputedStyle(d.querySelector(".zao-chatgpt-signin")).display !== "none" };
    `);
    assert.deepEqual(result.visible, [field], `visible fields for ${provider}`);
    assert.equal(result.chat, provider === "chatgpt");
  }
  await execute(`
    const d = document.querySelector('.sineItem[mod-id="zen-tab-sorting"] dialog');
    const change = (suffix, value, type) => {
      const node = d.querySelector("#extensions-zen-auto-organize-" + suffix + (type === "command" ? " menulist" : " input"));
      if (type === "command") node.setAttribute("value", value); else node.value = value;
      node.dispatchEvent(new Event(type, { bubbles: true }));
    };
    change("ai-jev-provider", "openrouter", "command");
    await new Promise(resolve => setTimeout(resolve, 50));
    if (d.querySelector("#extensions-zen-auto-organize-ai-jev-model input").value !== "typesafe/jev-1.13") throw new Error("Jev default model did not follow provider");
    change("ai-jev-model", "custom-jev-test", "change");
    change("ai-jev-provider", "typesafe", "command");
    if (d.querySelector("#extensions-zen-auto-organize-ai-jev-model input").value !== "custom-jev-test") throw new Error("Custom Jev model lost");
    change("ai-custom-model", "custom-llm-test", "change");
    change("ai-fallback-provider", "chatgpt", "command");
    const key = d.querySelector("#extensions-zen-auto-organize-ai-jev-api-key input");
    const reveal = key.parentElement.querySelector("button");
    reveal.click();
    if (key.type !== "text") throw new Error("Key reveal failed");
    reveal.click();
    if (key.type !== "password") throw new Error("Key hide failed");
    d.querySelector(".sineItemPreferenceDialogContent").scrollTop = 0;
  `);
  if (process.env.ZEN_SETTINGS_SCREENSHOT) {
    await delay(200);
    const png = await client.command("WebDriver:TakeScreenshot", { full: true });
    await writeFile(process.env.ZEN_SETTINGS_SCREENSHOT, Buffer.from(png, "base64"));
    await execute(`document.querySelector('[data-zao-section="llm"]').scrollIntoView({ block: "start" });`);
    await delay(150);
    const llm = await client.command("WebDriver:TakeScreenshot", { full: true });
    await writeFile(process.env.ZEN_SETTINGS_SCREENSHOT.replace(/\.png$/, "-llm.png"), Buffer.from(llm, "base64"));
    await execute(`document.querySelector('[data-zao-section="appearance"]').scrollIntoView({ block: "start" });`);
    await delay(150);
    const appearance = await client.command("WebDriver:TakeScreenshot", { full: true });
    await writeFile(process.env.ZEN_SETTINGS_SCREENSHOT.replace(/\.png$/, "-appearance.png"), Buffer.from(appearance, "base64"));
  }
  await client.setChromeContext();
  const persisted = await execute(`return {
    engine: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-engine"),
    provider: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-fallback-provider"),
    jevModel: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-jev-model"),
    llmModel: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-custom-model"),
    strength: Services.prefs.getStringPref("extensions.zen-auto-organize.new-group-color-strength")
  };`);
  assert.deepEqual(persisted, { engine: "jev", provider: "chatgpt", jevModel: "custom-jev-test", llmModel: "custom-llm-test", strength: "42" });
  console.log("settings-e2e: PASS complete Sine form, six LLM providers, models, masked keys, collapsed advanced settings and persistence");

} finally {
  try { await client?.quit(); } catch {}
  await stopZen(zen);
  await removeLabProfile(lab.profileDir);
}
