import test from "node:test";
import assert from "node:assert/strict";
import { withSortSession, updateSortButtonState } from "../modules/sort-session.mjs";

const button = id => ({
  attributes: new Map(), disabled: false,
  closest: () => ({ dataset: { uuid: id } }),
  setAttribute(name, value) { this.attributes.set(name, value); },
});
const windowFixture = () => {
  const buttons = [button("source"), button("target")];
  const win = { gZenWorkspaces: { activeWorkspace: "source" },
    document: { querySelectorAll: () => buttons }, addEventListener() {}, removeEventListener() {} };
  return { win, buttons };
};

test("A target-card session keeps one loader, disables competing commands, and rejects overlapping sorts", async () => {
  const { win, buttons } = windowFixture();
  let release;
  const result = withSortSession("tabs", async () => {
    assert.equal(buttons[0].attributes.get("aria-busy"), "false");
    assert.equal(buttons[1].attributes.get("aria-busy"), "true");
    assert.ok(buttons.every(node => node.disabled));
    const rebuilt = button("target");
    updateSortButtonState(rebuilt, win);
    assert.equal(rebuilt.attributes.get("aria-busy"), "true");
    assert.equal(rebuilt.disabled, true);
    await new Promise(resolve => { release = resolve; });
    return "finished";
  }, win, { workspaceId: "target" });
  await Promise.resolve();
  assert.deepEqual(await withSortSession("workspaces", () => assert.fail("Overlapping mutation"), win), { busy: true });
  release();
  assert.equal(await result, "finished");
  assert.equal(win._zaoSortSession, undefined);
  assert.ok(buttons.every(node => !node.disabled && node.attributes.get("aria-busy") === "false"));
});

test("A failing global sort clears every Space loader and releases the lock", async () => {
  const { win, buttons } = windowFixture();
  await assert.rejects(withSortSession("workspaces", () => {
    assert.ok(buttons.every(node => node.attributes.get("aria-busy") === "true"));
    throw new Error("Provider unavailable");
  }, win), /Provider unavailable/);
  assert.equal(win._zaoSortSession, undefined);
  assert.ok(buttons.every(node => !node.disabled && node.attributes.get("aria-busy") === "false"));
});
