const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
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
