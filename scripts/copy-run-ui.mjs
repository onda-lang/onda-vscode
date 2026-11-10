import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readOndaVersion } from "./onda-version.mjs";
import { verifyGpuUi } from "./stage-gpu-ui.mjs";

export function copyRunUi(root = process.cwd()) {
  const source = join(root, "ui/gpu");
  const destination = join(root, "out/gpu");
  if (!existsSync(join(source, "pkg/onda_ui_bg.wasm"))) {
    throw new Error("Stage the shared GPU UI with npm run stage:gpu before building the extension");
  }
  const version = readOndaVersion(root);
  // Keep the last complete bundle if staging is still in progress.
  verifyGpuUi(source, version);
  mkdirSync(join(root, "out"), { recursive: true });
  const pending = mkdtempSync(join(root, "out/.gpu-"));
  try {
    cpSync(source, pending, { recursive: true });
    // Staging may have replaced files while the copy was running.
    verifyGpuUi(pending, version);
    rmSync(destination, { recursive: true, force: true });
    renameSync(pending, destination);
  } finally {
    rmSync(pending, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  copyRunUi();
}
