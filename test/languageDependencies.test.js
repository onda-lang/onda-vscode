const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LanguageDependencies } = require("../out/languageDependencies");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for a dependency change");
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onda-language-watch-"));
  const entry = path.join(root, "workspace", "main.onda");
  const dependency = path.join(root, "external", "dependency.on");
  fs.mkdirSync(path.dirname(entry));
  fs.mkdirSync(path.dirname(dependency));
  fs.writeFileSync(entry, "entry\n");
  fs.writeFileSync(dependency, "original\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, entry, dependency };
}

test("external dependencies are watched without a run panel", async t => {
  const { entry, dependency } = fixture(t);
  const changes = [];
  let queries = 0;
  const watcher = new LanguageDependencies(async () => {
    queries++;
    return { files: [entry, dependency], complete: true };
  }, files => changes.push(...files), assert.fail);
  t.after(() => watcher.dispose());
  await watcher.open(entry);
  fs.writeFileSync(dependency, "changed\n");
  await until(() => changes.includes(dependency) && queries >= 2);
  watcher.close(entry);
  const previous = changes.length;
  fs.writeFileSync(dependency, "closed\n");
  await delay(200);
  assert.equal(changes.length, previous);
});

test("discovery revalidates the entry after installing watches without rediscovering in a loop", async t => {
  const { entry, dependency } = fixture(t);
  const changes = [];
  let queries = 0;
  const watcher = new LanguageDependencies(async () => {
    queries++;
    return { files: [entry, dependency], complete: true };
  }, files => changes.push(...files), assert.fail);
  t.after(() => watcher.dispose());
  await watcher.open(entry);
  assert.deepEqual(changes, [entry]);
  await delay(200);
  assert.equal(queries, 1);
  assert.deepEqual(changes, [entry]);
});

test("incomplete graphs retain dependencies and recover missing paths", async t => {
  const { root, entry, dependency } = fixture(t);
  const missing = path.join(root, "new", "nested", "missing.on");
  let graph = { files: [entry, dependency], complete: true };
  const changes = [];
  const watcher = new LanguageDependencies(async () => graph, files => changes.push(...files), assert.fail);
  t.after(() => watcher.dispose());
  await watcher.open(entry);
  graph = { files: [entry, missing], complete: false };
  await watcher.open(entry);
  fs.writeFileSync(dependency, "still watched\n");
  await until(() => changes.includes(dependency));
  fs.mkdirSync(path.dirname(missing), { recursive: true });
  fs.writeFileSync(missing, "created\n");
  await until(() => changes.includes(missing));
  graph = { files: [entry], complete: true };
  await watcher.open(entry);
  const previous = changes.length;
  fs.writeFileSync(dependency, "obsolete\n");
  fs.writeFileSync(missing, "obsolete\n");
  await delay(200);
  assert.equal(changes.length, previous);
});

test("closing or disposing rejects stale graphs and cancels pending frontend work", async t => {
  const { entry, dependency } = fixture(t);
  let finish;
  let signal;
  let queries = 0;
  const changes = [];
  const watcher = new LanguageDependencies((_file, pending) => {
    queries++;
    signal = pending;
    return new Promise(resolve => { finish = resolve; });
  }, files => changes.push(...files), assert.fail);
  t.after(() => watcher.dispose());
  const loading = watcher.open(entry);
  await until(() => finish);
  watcher.close(entry);
  assert.equal(signal.aborted, true);
  finish({ files: [entry, dependency], complete: true });
  await loading;
  watcher.dispose();
  await watcher.open(entry);
  assert.equal(queries, 1);
  fs.writeFileSync(dependency, "obsolete reply\n");
  await delay(200);
  assert.deepEqual(changes, []);
});

test("editor changes refresh affected importers once and closing an overlay refreshes them again", async t => {
  const { root, entry, dependency } = fixture(t);
  const other = path.join(root, "other.onda");
  fs.writeFileSync(other, "unrelated\n");
  const queries = [];
  const watcher = new LanguageDependencies(async file => {
    queries.push(file);
    return { files: file === entry ? [entry, dependency] : [file], complete: true };
  }, () => {}, assert.fail);
  t.after(() => watcher.dispose());
  await watcher.open(entry);
  await watcher.open(dependency);
  await watcher.open(other);
  queries.length = 0;
  for (let i = 0; i < 5; i++) watcher.change(dependency);
  await until(() => queries.length >= 2);
  assert.deepEqual(queries.sort(), [entry, dependency].sort());
  queries.length = 0;
  watcher.close(dependency);
  await until(() => queries.length > 0);
  assert.deepEqual(queries, [entry]);
  watcher.change(entry);
  watcher.dispose();
  await delay(200);
  assert.deepEqual(queries, [entry]);
});

test("an editor change rejects an in-flight graph before the replacement discovery starts", async t => {
  const { entry, dependency } = fixture(t);
  let finish;
  let signal;
  let queries = 0;
  const changes = [];
  const watcher = new LanguageDependencies((_file, pending) => {
    if (++queries > 1) return Promise.resolve({ files: [entry], complete: true });
    signal = pending;
    return new Promise(resolve => { finish = resolve; });
  }, files => changes.push(...files), assert.fail);
  t.after(() => watcher.dispose());
  const loading = watcher.open(entry);
  await until(() => finish);
  watcher.change(entry);
  assert.equal(signal.aborted, true);
  finish({ files: [entry, dependency], complete: true });
  await loading;
  assert.deepEqual(changes, []);
  await until(() => queries === 2 && changes.includes(entry));
  changes.length = 0;
  fs.writeFileSync(dependency, "stale dependency\n");
  await delay(200);
  assert.deepEqual(changes, []);
});
