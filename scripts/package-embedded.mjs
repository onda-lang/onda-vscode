import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionRoot, verifyCompilerBundle } from "./compiler-bundle.mjs";
import { stageCompiler } from "./stage-compiler.mjs";

export function packageEmbeddedCompiler(output) {
  const manifest = verifyCompilerBundle();
  const require = createRequire(import.meta.url);
  const vsce = resolve(dirname(require.resolve("@vscode/vsce/package.json")), "vsce");
  const destination = resolve(output || `onda-embedded-${manifest.target}.vsix`);
  const result = spawnSync(process.execPath, [vsce, "package", "--target", manifest.target, "--out", destination], {
    cwd: extensionRoot,
    env: { ...process.env, ONDA_VSIX_TARGET: manifest.target },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`VSIX packaging failed with status ${result.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error("Usage: npm run package:embedded -- /path/to/extracted-onda-release <target> [output.vsix]");
  }
  stageCompiler(process.argv[2], process.argv[3]);
  packageEmbeddedCompiler(process.argv[4]);
}
