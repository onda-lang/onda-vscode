const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { createRunPanel } = require("./helpers/runPanel");

test("run panel shows the version of the configured Onda executable", () => {
  const { messages } = createRunPanel();
  const state = messages.at(-1).state;
  const node = { hidden: true, textContent: "" };
  const numberNode = { textContent: "" };
  const html = fs.readFileSync(path.join(__dirname, "..", "ui", "run", "run.html"), "utf8");
  const versionScript = html.slice(html.indexOf("const ondaVersionNode"), html.indexOf("showOndaVersion(window.__hostBridge?.ondaVersion);"));
  vm.runInNewContext(versionScript + "\nshowOndaVersion(incoming.ondaVersion);", {
    document: { getElementById: id => id === "onda-version" ? node : numberNode }, incoming: state,
  });
  assert.equal(node.hidden, false);
  assert.equal(numberNode.textContent, "0.8.20");
});

test("missing server version leaves the run panel usable", () => {
  const { messages } = createRunPanel(null);
  assert.equal(messages.at(-1).state.status, "Stopped");
  assert.equal(messages.at(-1).state.error, undefined);
  assert.equal(messages.at(-1).state.ondaVersion, undefined);
});

test("server initialization updates an already open run panel", async () => {
  const { context, messages } = createRunPanel(null);
  await vm.runInContext("startClient({ subscriptions: [] })", context);
  assert.equal(messages.at(-1).state.ondaVersion, "0.8.20");
});
