const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { mergeRunDependencies, parseRunSourceGraph } = require("../out/runDependencies.js");

const entry = path.resolve("main.onda");
const oldImport = path.resolve("old.onda");
const newImport = path.resolve("new.onda");

test("complete graphs replace obsolete dependencies and retain the selected input", () => {
  const files = mergeRunDependencies(entry, new Set([oldImport]), { files: [newImport], complete: true });
  assert.deepEqual(files, new Set([entry, newImport]));
});

test("incomplete graphs preserve prior dependencies and add unresolved imports", () => {
  const files = mergeRunDependencies(entry, new Set([oldImport]), { files: [newImport], complete: false });
  assert.deepEqual(files, new Set([entry, oldImport, newImport]));
});

test("malformed graphs do not replace the current dependency list", () => {
  const previous = new Set([entry, oldImport]);
  for (const graph of [null, {}, { complete: true, files: [null] }, { complete: true, files: ["relative.onda"] }]) {
    assert.deepEqual(mergeRunDependencies(entry, previous, graph), previous);
  }
});

test("content hashes accept captured and missing files and reject invalid projections", () => {
  const graph = { files: [entry, newImport], complete: false,
    contentHashes: { [entry]: "a".repeat(64), [newImport]: null } };
  assert.deepEqual(parseRunSourceGraph(graph), graph);
  for (const contentHashes of [null, [], { [entry]: 1 }, { [entry]: "short" },
    { [oldImport]: "a".repeat(64) }]) {
    assert.equal(parseRunSourceGraph({ ...graph, contentHashes }), undefined);
  }
});

test("Windows compiler paths normalize drive and UNC namespaces before entering the host", () => {
  const context = { exports: {}, process: { platform: "win32" },
    require(name) { return name === "path" ? path.win32 : require(name); } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../out/runDependencies.js"), "utf8"), context);
  for (const [reported, expected] of [
    [String.raw`\\?\C:\Sources\main.onda`, String.raw`C:\Sources\main.onda`],
    [String.raw`\\?\UNC\server\share\main.onda`, String.raw`\\server\share\main.onda`],
    [String.raw`c:\Sources\main.onda`, String.raw`C:\Sources\main.onda`],
  ]) {
    const hash = "a".repeat(64);
    const graph = context.exports.parseRunSourceGraph({ files: [reported], complete: true,
      contentHashes: { [reported]: hash } });
    assert.equal(graph.files[0], expected);
    assert.equal(graph.contentHashes[expected], hash);
    assert.equal(context.exports.mergeRunDependencies(expected, new Set(), graph).size, 1);
  }
});
