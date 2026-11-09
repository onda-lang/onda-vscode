import { build } from "esbuild";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { extensionRoot } from "./onda-version.mjs";

await build({
  absWorkingDir: extensionRoot,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  legalComments: "eof",
});

// The language client resolves its Unix process-tree cleanup script by __dirname.
const require = createRequire(import.meta.url);
const client = dirname(require.resolve("vscode-languageclient/node"));
copyFileSync(join(client, "lib/node/terminateProcess.sh"), join(extensionRoot, "out/terminateProcess.sh"));
