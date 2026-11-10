import { packageEmbeddedCompiler } from "./package-embedded.mjs";
import { stageGpuUi } from "./stage-gpu-ui.mjs";

const source = process.argv[2] || process.env.ONDA_GPU_UI_DIR;
if (!source) throw new Error("Usage: npm run package:gpu -- /path/to/onda/ui/gpu [output.vsix]");
stageGpuUi(source);
// vsce runs vscode:prepublish, which compiles and copies the staged assets.
packageEmbeddedCompiler(process.argv[3] || "onda-gpu.vsix");
