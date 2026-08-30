const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyRunOutputNotification,
  clearRunLogState,
  initialRunLogState,
} = require("../out/runLog.js");

test("collects structured print output and loss counters", () => {
  const entry = {
    source: { file: "voice.onda", line: 12 },
    lexicalOwner: "sample",
  };
  const state = applyRunOutputNotification(initialRunLogState(), {
    event: "print",
    text: "frequency=440\n",
    entries: [entry],
    overflowCount: 2,
    transportDropCount: 3,
  }, []);

  assert.deepEqual(state, {
    logText: "frequency=440\n",
    logEntries: [entry],
    logRevealed: true,
    printOverflowCount: 2,
    printTransportDropCount: 3,
    delegateOverflowCount: 0,
    delegateTransportDropCount: 0,
  });
});

test("formats delegate notifications in declared parameter order", () => {
  const state = applyRunOutputNotification(initialRunLogState(), {
    event: "delegates",
    occurrences: [{
      sequence: 7,
      index: 1,
      name: "meter",
      values: { peak: 0.75, frame: "9007199254740993" },
    }],
    overflowCount: 1,
    transportDropCount: 4,
  }, [{
    index: 1,
    name: "meter",
    params: [
      { name: "frame", type: "i64" },
      { name: "peak", type: "f64" },
    ],
  }]);

  assert.equal(state.logText, "delegate meter: frame=9007199254740993 peak=0.75\n");
  assert.equal(state.logEntries[0].kind, "delegate");
  assert.equal(state.delegateOverflowCount, 1);
  assert.equal(state.delegateTransportDropCount, 4);
});

test("bounds visible history and keeps the log revealed after clearing", () => {
  const count = 4100;
  const state = applyRunOutputNotification(initialRunLogState(), {
    event: "print",
    text: Array.from({ length: count }, (_, index) => `line ${index}`).join("\n") + "\n",
    entries: Array.from({ length: count }, (_, index) => ({ index })),
  }, []);

  assert.equal(state.logEntries.length, 4096);
  assert.match(state.logText, /^line 4\n/);
  assert.match(state.logText, /line 4099\n$/);
  assert.deepEqual(clearRunLogState(state), {
    ...initialRunLogState(),
    logRevealed: true,
  });
});

test("ignores control responses that are not output notifications", () => {
  assert.equal(applyRunOutputNotification(
    initialRunLogState(),
    { id: 1, ok: true, result: {} },
    [],
  ), undefined);
});
