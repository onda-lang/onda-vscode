const assert = require("node:assert/strict");
const test = require("node:test");

const grammar = require("../syntaxes/onda.tmLanguage.json");
const manifest = require("../package.json");
const projectSchema = require("../schemas/project.json");

const ondaSemanticTokenTypes = [
  "enumMember",
  "variable",
  "port",
  "parameter",
  "function",
  "type",
  "namespace",
  "state",
  "keyword",
  "number",
  "event",
  "delegate",
];

const vscodeStandardSemanticTokenTypes = new Set([
  "enumMember",
  "variable",
  "parameter",
  "function",
  "type",
  "namespace",
  "keyword",
  "number",
  "event",
]);

const sectionPattern = new RegExp(
  grammar.repository["section-headers"].patterns[0].match,
);
const declarationPattern = new RegExp(
  grammar.repository.declarations.patterns[2].match,
);
const keywordPattern = new RegExp(
  grammar.repository.keywords.patterns[0].match,
);

test("section keywords only match complete identifiers", () => {
  assert.equal(sectionPattern.exec("blocks_processed = 0"), null);
  assert.equal(sectionPattern.exec("sample_count = 0"), null);
  assert.equal(sectionPattern.exec("block:")?.[2], "block");
  assert.equal(sectionPattern.exec("sample 4:")?.[2], "sample");
  assert.equal(sectionPattern.exec("delegates:")?.[2], "delegates");
  assert.equal(sectionPattern.exec("tasks:")?.[2], "tasks");
});

test("Onda 0.8 declarations and control words have fallback highlighting", () => {
  for (const declaration of ["def", "event", "delegate", "task"]) {
    assert.equal(
      declarationPattern.exec(`${declaration} ready():`)?.[2],
      declaration,
    );
  }
  for (const keyword of [
    "await",
    "yield",
    "private",
    "config",
    "when",
    "print",
  ]) {
    assert.equal(keywordPattern.test(keyword), true, keyword);
  }
});

test("every Onda semantic token is standard or explicitly contributed", () => {
  const contributedTypes = new Map(
    manifest.contributes.semanticTokenTypes.map((token) => [token.id, token]),
  );
  assert.deepEqual(
    ondaSemanticTokenTypes.filter(
      (token) => !vscodeStandardSemanticTokenTypes.has(token) && !contributedTypes.has(token),
    ),
    [],
  );
  assert.equal(contributedTypes.get("port")?.superType, "variable");
  assert.equal(contributedTypes.get("state")?.superType, "variable");
  assert.equal(contributedTypes.get("delegate")?.superType, "event");

  const ondaScopes = manifest.contributes.semanticTokenScopes.find(
    ({ language }) => language === "onda",
  );
  assert.deepEqual(ondaScopes?.scopes.port, ["support.variable"]);
  assert.deepEqual(ondaScopes?.scopes.state, ["variable.parameter"]);
  assert.deepEqual(ondaScopes?.scopes.event, ["entity.name.function"]);
  assert.deepEqual(ondaScopes?.scopes.delegate, ["entity.name.function"]);
});

test("project schema accepts Onda 0.8 compile constants", () => {
  assert.equal(projectSchema.properties.constants.type, "object");
  assert.deepEqual(
    projectSchema.$defs.constantScalar.oneOf.map((entry) => entry.type),
    ["boolean", "number", "string"],
  );
  assert.equal(
    projectSchema.$defs.constantValue.oneOf[1].items.$ref,
    "#/$defs/constantScalar",
  );
});
