const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { createRunPanel } = require("./helpers/runPanel");

test("run panel shows the version of the configured Onda executable", () => {
  const { messages } = createRunPanel();
  const state = messages.at(-1).state;
  assert.equal(state.ondaVersion, "0.8.20");
});

test("missing server version leaves the run panel usable", () => {
  const { messages } = createRunPanel(null);
  assert.equal(messages.at(-1).state.status, "Stopped");
  assert.equal(messages.at(-1).state.error, null);
  assert.equal(messages.at(-1).state.ondaVersion, undefined);
});

test("server initialization updates an already open run panel", async () => {
  const { context, messages } = createRunPanel(null);
  await vm.runInContext("startClient({ subscriptions: [] })", context);
  assert.equal(messages.at(-1).state.ondaVersion, "0.8.20");
});
