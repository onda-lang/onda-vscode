const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeMidiInputDevices,
  runMidiNoteEvent,
} = require("../out/runMidi.js");

const midi = { available: true, noteOn: true, noteOff: true };

test("MIDI device options include one computer keyboard entry", () => {
  assert.deepEqual(
    normalizeMidiInputDevices(["Controller", "Computer Keyboard"]),
    ["Computer Keyboard", "Controller"],
  );
});

test("virtual MIDI notes map to canonical clamped host events", () => {
  assert.deepEqual(runMidiNoteEvent(midi, 128.9, 1.5, true), {
    name: "note_on",
    values: [-1, 0, 127, 1],
  });
  assert.deepEqual(runMidiNoteEvent(midi, -2, 0.4, false), {
    name: "note_off",
    values: [-1, 0, 0, 0.4],
  });
});

test("virtual MIDI notes require the corresponding declared event", () => {
  assert.equal(
    runMidiNoteEvent({ ...midi, noteOff: false }, 60, 0, false),
    undefined,
  );
  assert.equal(runMidiNoteEvent(midi, Number.NaN, 0.8, true), undefined);
});
