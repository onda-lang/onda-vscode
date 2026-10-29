import { verifyCompilerBundle } from "./compiler-bundle.mjs";
import { verifyGpuUi } from "./stage-gpu-ui.mjs";

const target = process.env.ONDA_VSIX_TARGET;
if (process.argv.includes("--packaging") && !target) {
  throw new Error("Package through npm run package:embedded (or package:gpu) so the VSIX targets its bundled compiler's platform.");
}
const manifest = verifyCompilerBundle(undefined, target);
if (process.argv.includes("--packaging")) verifyGpuUi();
console.log(`Verified bundled Onda ${manifest.version} (${manifest.target})`);
