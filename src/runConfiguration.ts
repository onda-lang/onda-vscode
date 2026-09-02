export interface RunProcessConfiguration {
  sampleRateHz: number;
  blockFrames: number;
  inputDevice: string | null;
  outputDevice: string | null;
  midiInputDevice: string | null;
}

export function sameRunProcessConfiguration(
  active: RunProcessConfiguration | undefined,
  desired: RunProcessConfiguration,
): boolean {
  return active !== undefined &&
    active.sampleRateHz === desired.sampleRateHz &&
    active.blockFrames === desired.blockFrames &&
    active.inputDevice === desired.inputDevice &&
    active.outputDevice === desired.outputDevice &&
    active.midiInputDevice === desired.midiInputDevice;
}
