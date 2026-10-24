import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkspaceJevPayload, classifyWorkspaceUnitsWithJev, evaluateWorkspaceAnswer, isGenericWorkspaceName } from "../modules/workspace-jev.mjs";

const spaces = [{ id: "a", name: "SocialMedia" }, { id: "b", name: "Development" }];
const unit = (name = "Flutter packages") => ({ id: name, name, kind: "group", workspaceId: "a", tabs: [] });
const settings = { model: "jev-test", apiKey: "test-token", jevProvider: "typesafe", consentToSendData: true };
const answer = (a = 0.2, b = 0.8) => ({ choice: "a", probabilities: { a, b } });
const response = (answers) => new Response(JSON.stringify({ answers }));

test("Workspace names own their meaning; misplaced contents cannot redefine named Spaces", () => {
  const payload = buildWorkspaceJevPayload({ model: "jev-test", workspaces: spaces.map((space) => ({ ...space, examples: [{ title: "MISFILED-FLUTTER", hostname: "pub.dev" }] })), units: [unit()] });
  assert.deepEqual(Object.keys(payload), ["model", "state", "questions"]);
  assert.deepEqual(Object.keys(payload.questions.unit_0.criteria), ["a", "b"]);
  assert.match(payload.questions.unit_0.criteria.a, /NAME is the highest authority/);
  assert.doesNotMatch(JSON.stringify(payload), /MISFILED-FLUTTER|__none__/);
});

test("Generic Space names get weak examples, excluding the unit being judged", () => {
  const ownTab = {};
  const input = { ...unit(), _tabs: [ownTab], tabs: [{ title: "Own tab", _tab: ownTab }] };
  const payload = buildWorkspaceJevPayload({ model: "jev-test", units: [input], workspaces: [{ id: "a", name: "Space2", examples: [{ title: "SELF-EVIDENCE", _tab: ownTab }, { title: "Other example" }] }, spaces[1]] });
  assert.match(payload.questions.unit_0.criteria.a, /weak contextual clues.*Other example/);
  assert.doesNotMatch(payload.questions.unit_0.criteria.a, /SELF-EVIDENCE/);
  assert.equal(isGenericWorkspaceName("Workspace 3"), true);
  assert.equal(isGenericWorkspaceName("💻"), true);
  assert.equal(isGenericWorkspaceName("SocialMedia"), false);
});

test("A complete folder tree is one question; duplicate Space names retain separate IDs", () => {
  const input = { ...unit(), kind: "folder", tabs: [{ title: "Flutter", hostname: "pub.dev" }, { title: "Dart", hostname: "dart.dev" }], groupNames: ["Subfolder"] };
  const payload = buildWorkspaceJevPayload({ model: "jev-test", units: [input], workspaces: spaces.map((space) => ({ ...space, name: "Same" })) });
  assert.equal(Object.keys(payload.questions).length, 1);
  assert.deepEqual(Object.keys(payload.questions.unit_0.criteria), ["a", "b"]);
  assert.equal(payload.state.units[0].tabs.length, 2);
  assert.deepEqual(payload.state.units[0].subgroups, ["Subfolder"]);
  assert.doesNotMatch(JSON.stringify(payload), /_tab/);
});

test("Argmax uses every Space score and requires strictly more than ten points over the origin", () => {
  assert.equal(evaluateWorkspaceAnswer(unit(), spaces, answer(0.40, 0.49)).shouldMove, false);
  assert.equal(evaluateWorkspaceAnswer(unit(), spaces, answer(0.40, 0.50)).shouldMove, false);
  assert.equal(evaluateWorkspaceAnswer(unit(), spaces, answer(0.60, 0.70)).shouldMove, false);
  const result = evaluateWorkspaceAnswer(unit(), spaces, answer(0.40, 0.51));
  assert.equal(result.toWorkspaceId, "b");
  assert.equal(result.shouldMove, true); // Even though answer.choice says a.
  // The runner-up has no influence on the requested origin-relative margin.
  const three = [...spaces, { id: "c", name: "Other" }];
  assert.equal(evaluateWorkspaceAnswer(unit(), three, { probabilities: { a: 0.1, b: 0.46, c: 0.44 } }).toWorkspaceId, "b");
});

test("Exact ties keep the origin or otherwise use the existing Space order", () => {
  assert.equal(evaluateWorkspaceAnswer(unit(), [...spaces].reverse(), answer(0.5, 0.5)).toWorkspaceId, "a");
  const three = [...spaces, { id: "c", name: "Other" }];
  assert.equal(evaluateWorkspaceAnswer(unit(), three, { probabilities: { a: 0.1, b: 0.45, c: 0.45 } }).toWorkspaceId, "b");
});

test("Missing, invalid and out-of-range scores never guess a target", () => {
  for (const probabilities of [{ b: 0.9 }, { a: null, b: 0.9 }, { a: "0.1", b: 0.9 }, { a: -1, b: 0.9 }, { a: 0.1, b: Infinity }, { a: 0.1, b: 90 }]) {
    assert.throws(() => evaluateWorkspaceAnswer(unit(), spaces, { probabilities }), /Space-Scores/);
  }
});

test("Only invalid answers retry once; successful answers and all following units survive", async () => {
  const inputs = [unit("first"), unit("broken"), unit("third")];
  const batches = [];
  const result = await classifyWorkspaceUnitsWithJev({
    units: inputs, workspaces: spaces, settings, wait: async () => {},
    fetchImpl: async (url, request) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      const payload = JSON.parse(request.body);
      batches.push(payload.state.units.map((item) => item.name));
      return batches.length === 1 ? response({ unit_0: answer(), unit_2: answer() }) : response({ unit_0: answer() });
    },
  });
  assert.deepEqual(batches, [["first", "broken", "third"], ["broken"]]);
  assert.deepEqual(result.decisions.map((decision) => decision.unit.name), ["first", "broken", "third"]);
  assert.deepEqual(result.errors, []);
});

test("A permanently broken element is attempted exactly twice and then reported", async () => {
  let calls = 0;
  const result = await classifyWorkspaceUnitsWithJev({
    units: [unit("broken"), unit("valid")], workspaces: spaces, settings, wait: async () => {},
    fetchImpl: async () => { calls++; return response(calls === 1 ? { unit_1: answer() } : {}); },
  });
  assert.equal(calls, 2);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].unit.name, "broken");
});

test("Failed requests retry once and later 25-question batches continue without fallback", async () => {
  let calls = 0;
  const inputs = Array.from({ length: 26 }, (_, i) => unit(String(i)));
  const result = await classifyWorkspaceUnitsWithJev({
    units: inputs, workspaces: spaces, settings, wait: async () => {},
    fetchImpl: async (url) => {
      calls++;
      assert.match(url, /typesafe/);
      if (calls < 3) return new Response("unavailable", { status: 503 });
      return response({ unit_0: answer() });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.errors.length, 25);
  assert.equal(result.decisions[0].unit.name, "25");
});

test("A transient connection failure recovers with one retry", async () => {
  let calls = 0;
  const result = await classifyWorkspaceUnitsWithJev({
    units: [unit()], workspaces: spaces, settings, wait: async () => {},
    fetchImpl: async () => { if (++calls === 1) throw new Error("offline"); return response({ unit_0: answer() }); },
  });
  assert.equal(calls, 2);
  assert.equal(result.decisions.length, 1);
});

test("Consent and configured Jev credentials are required, even with another engine selected", async () => {
  let calls = 0;
  const options = { units: [unit()], workspaces: spaces, fetchImpl: async () => { calls++; } };
  await assert.rejects(classifyWorkspaceUnitsWithJev({ ...options, settings: { ...settings, consentToSendData: false } }), /Datenfreigabe/);
  await assert.rejects(classifyWorkspaceUnitsWithJev({ ...options, settings: { ...settings, apiKey: "" } }), /Zugangsschlüssel/);
  assert.equal(calls, 0);
});

test("Zero or one Space and empty input make no network request", async () => {
  const fetchImpl = async () => { throw new Error("No network expected"); };
  for (const workspaces of [[], spaces.slice(0, 1)]) {
    assert.deepEqual(await classifyWorkspaceUnitsWithJev({ units: [unit()], workspaces, fetchImpl }), { decisions: [], errors: [] });
  }
  assert.deepEqual(await classifyWorkspaceUnitsWithJev({ units: [], workspaces: spaces, fetchImpl }), { decisions: [], errors: [] });
});
