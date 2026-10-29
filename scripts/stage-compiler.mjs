import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compilerVersion, extensionRoot, targetInfo, verifyCompilerFiles } from "./compiler-bundle.mjs";

export function stageCompiler(releaseDirectory, target, root = extensionRoot) {
  const info = targetInfo(target);
  if (target !== `${process.platform}-${process.arch}`) {
    throw new Error(`Stage ${target} on a matching host so the compiler version can be verified by running it.`);
  }
  const source = resolve(releaseDirectory);
  const sha256 = verifyCompilerFiles(source, target);
  const result = spawnSync(join(source, "bin", info.executable), ["--version"], {
    encoding: "utf8", timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== `Onda ${compilerVersion}`) {
    throw new Error(`Expected Onda ${compilerVersion}; received ${result.stdout.trim() || result.stderr.trim()}`);
  }

  const temporary = mkdtempSync(join(tmpdir(), "onda-compiler-stage-"));
  try {
    const bundle = join(temporary, "compiler");
    const destination = join(bundle, target);
    mkdirSync(destination, { recursive: true });
    for (const name of ["bin", "licenses", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      cpSync(join(source, name), join(destination, name), { recursive: true });
    }
    if (target !== "win32-x64") chmodSync(join(destination, "bin", info.executable), 0o755);
    const manifest = { version: compilerVersion, target, sha256 };
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    // Replace generated assets only after validating the full incoming bundle.
    rmSync(join(root, "compiler"), { recursive: true, force: true });
    // cpSync also works when the system temporary directory is on another volume.
    cpSync(bundle, join(root, "compiler"), { recursive: true });
    console.log(`Staged Onda ${compilerVersion} for ${target}`);
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error("Usage: npm run stage:compiler -- /path/to/extracted-onda-release <target>");
  }
  stageCompiler(process.argv[2], process.argv[3]);
}
