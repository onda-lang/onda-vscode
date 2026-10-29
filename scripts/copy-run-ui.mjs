import { cpSync, existsSync } from "node:fs";
if (!existsSync("./ui/gpu/pkg/onda_ui_bg.wasm")) {
  throw new Error("Stage the shared GPU UI with npm run stage:gpu before building the extension");
}
cpSync("./ui/gpu", "./out/gpu", { recursive: true });
