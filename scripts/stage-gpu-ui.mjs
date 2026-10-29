import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const source = process.argv[2] || process.env.ONDA_GPU_UI_DIR;
if (!source || !existsSync(resolve(source, "pkg/onda_ui_bg.wasm"))) {
  throw new Error("Pass the built Onda ui/gpu directory: npm run stage:gpu -- /path/to/onda/ui/gpu");
}
mkdirSync("ui/gpu", { recursive: true });
for (const name of ["index.html", "host.js", "browser.js", "protocol.js", "text-input.js", "pkg"]) cpSync(resolve(source, name), `ui/gpu/${name}`, { recursive: true });
