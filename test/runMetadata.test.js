const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeRunParams } = require("../out/runMetadata.js");

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
