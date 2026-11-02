const assert = require("node:assert/strict");
const test = require("node:test");

const { initialRunParamValue, normalizeRunParams, sameEnumChoices } = require("../out/runMetadata.js");

test("decodes current lossless run parameter metadata", () => {
  const [param] = normalizeRunParams([{
    index: 2,
    name: "frequency",
    type: "f32",
    scalar: true,
    valueRepr: "110",
    defaultRepr: "110",
    rangeMinRepr: "20",
    rangeMaxRepr: "1000",
    scale: "log",
    curveRepr: null,
    unit: "Hz",
    stepRepr: "0.5",
    stepCount: 1960,
  }]);

  assert.deepEqual(param, {
    index: 2,
    name: "frequency",
    type: "f32",
    value: 110,
    default: 110,
    rangeMin: 20,
    rangeMax: 1000,
    scale: "log",
    curve: null,
    unit: "Hz",
    step: 0.5,
    stepCount: 1960,
    enumeration: null,
    scalar: true,
  });
});

test("keeps compatibility with numeric and snake-case daemon metadata", () => {
  const [param] = normalizeRunParams([{
    index: 1,
    name: "mix",
    type_repr: "f64",
    value: 0.4,
    default: 0.5,
    range_min: 0,
    range_max: 1,
    curve: 1.25,
    step_count: 100,
  }]);

  assert.equal(param.value, 0.4);
  assert.equal(param.default, 0.5);
  assert.equal(param.rangeMin, 0);
  assert.equal(param.rangeMax, 1);
  assert.equal(param.curve, 1.25);
  assert.equal(param.stepCount, 100);
});

test("decodes boolean representations without treating missing values as false", () => {
  const [enabled, missing] = normalizeRunParams([
    { name: "enabled", type: "bool", valueRepr: "true", defaultRepr: "false" },
    { name: "missing", type: "bool" },
  ]);

  assert.equal(enabled.value, true);
  assert.equal(enabled.default, 0);
  assert.equal(missing.value, null);
});

test("initializes an explicitly false boolean parameter as false", () => {
  const [liveInput] = normalizeRunParams([{
    name: "live_input",
    type: "bool",
    valueRepr: "false",
    defaultRepr: "false",
  }]);

  assert.equal(initialRunParamValue(liveInput), false);
});

test("preserves enum names and labels while values stay i32 ordinals", () => {
  const enumeration = {
    name: "dsp::Mode",
    members: [
      { name: "LowPass", label: "Low Pass" },
      { name: "HighPass", label: "High-pass" },
    ],
  };
  const [param] = normalizeRunParams([{
    name: "mode", type: "i32", enumeration,
    valueRepr: "1", defaultRepr: "0", rangeMinRepr: "0", rangeMaxRepr: "1",
    stepRepr: "1", stepCount: 1,
  }]);
  assert.deepEqual(param.enumeration, enumeration);
  assert.equal(initialRunParamValue(param), 1);

  const [fixed] = normalizeRunParams([{
    name: "fixed", type: "i32", defaultRepr: "0",
    rangeMinRepr: "0", rangeMaxRepr: "0", stepRepr: "1", stepCount: 0,
    enumeration: { name: "Only", members: [{ name: "Value", label: "Only value" }] },
  }]);
  assert.equal(fixed.stepCount, 0);
  assert.equal(fixed.enumeration.members.length, 1);
  assert.equal(initialRunParamValue(fixed), 0);
});

test("enum preservation follows member identity and order, independently of labels", () => {
  const enumeration = {
    name: "Mode", members: [{ name: "A", label: "First" }, { name: "B", label: "Second" }],
  };
  assert.equal(sameEnumChoices(enumeration, structuredClone(enumeration)), true);
  assert.equal(sameEnumChoices(enumeration, {
    ...enumeration, members: enumeration.members.map(member => ({ ...member, label: "Updated" })),
  }), true);
  assert.equal(sameEnumChoices(enumeration, { ...enumeration, name: "Other" }), false);
  assert.equal(sameEnumChoices(enumeration, { ...enumeration, members: [...enumeration.members].reverse() }), false);
  assert.equal(sameEnumChoices(enumeration, null), false);
  assert.equal(sameEnumChoices(null, null), true);
});

test("malformed enum metadata cannot reach the run UI", () => {
  for (const enumeration of [
    null, "Mode", {}, { name: "Mode", members: [] },
    { name: "Mode", members: [{ name: "A" }] },
    { name: "Mode", members: [{ name: "A", label: 1 }] },
    { name: "Mode", members: [{ name: "A", label: "A" }, { name: "A", label: "Again" }] },
  ]) {
    const [param] = normalizeRunParams([{ name: "mode", type: "i32", enumeration }]);
    assert.equal(param.enumeration, null);
  }
});
