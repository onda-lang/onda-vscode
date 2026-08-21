const assert = require("node:assert/strict");
const test = require("node:test");

const grammar = require("../syntaxes/onda.tmLanguage.json");

const sectionPattern = new RegExp(
  grammar.repository["section-headers"].patterns[0].match,
);

test("section keywords only match complete identifiers", () => {
  assert.equal(sectionPattern.exec("blocks_processed = 0"), null);
  assert.equal(sectionPattern.exec("sample_count = 0"), null);
  assert.equal(sectionPattern.exec("block:")?.[2], "block");
  assert.equal(sectionPattern.exec("sample 4:")?.[2], "sample");
});
