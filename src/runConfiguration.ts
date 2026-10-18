export interface RunProcessConfiguration {
  host: "webview" | "egui";
  sampleRateHz: number;
  blockFrames: number;
  fastMath: boolean;
  inputDevice: string | null;
  outputDevice: string | null;
  midiInputDevice: string | null;
}

export function sameRunProcessConfiguration(
  active: RunProcessConfiguration | undefined,
  desired: RunProcessConfiguration,
): boolean {
  return active !== undefined &&
    active.host === desired.host &&
    active.sampleRateHz === desired.sampleRateHz &&
    active.blockFrames === desired.blockFrames &&
    active.fastMath === desired.fastMath &&
    active.inputDevice === desired.inputDevice &&
    active.outputDevice === desired.outputDevice &&
    active.midiInputDevice === desired.midiInputDevice;
}
