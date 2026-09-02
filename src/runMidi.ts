export interface RunMidiCapabilities {
  available: boolean;
  noteOn: boolean;
  noteOff: boolean;
}

export interface RunMidiNoteEvent {
  name: "note_on" | "note_off";
  values: [number, number, number, number];
}

export const COMPUTER_KEYBOARD_MIDI_INPUT = "Computer Keyboard";
export const NO_MIDI_CAPABILITIES: RunMidiCapabilities = {
  available: false,
  noteOn: false,
  noteOff: false,
};

export function normalizeMidiInputDevices(devices: string[] | undefined): string[] {
  return [
    COMPUTER_KEYBOARD_MIDI_INPUT,
    ...(devices ?? []).filter((device) => device !== COMPUTER_KEYBOARD_MIDI_INPUT),
  ];
}

export function runMidiNoteEvent(
  capabilities: RunMidiCapabilities,
  key: unknown,
  velocity: unknown,
  pressed: unknown,
): RunMidiNoteEvent | undefined {
  if (typeof pressed !== "boolean") {
    return undefined;
  }
  const name = pressed
    ? (capabilities.noteOn ? "note_on" : undefined)
    : (capabilities.noteOff ? "note_off" : undefined);
  if (!name || typeof key !== "number" || !Number.isFinite(key)) {
    return undefined;
  }
  const normalizedVelocity =
    typeof velocity === "number" && Number.isFinite(velocity)
      ? Math.max(0, Math.min(1, velocity))
      : 0;
  return {
    name,
    values: [-1, 0, Math.max(0, Math.min(127, Math.trunc(key))), normalizedVelocity],
  };
}
