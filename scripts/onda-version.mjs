import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Match onda-plugin: ONDA_VERSION overrides the first line of onda-version.
export function readOndaVersion(root = extensionRoot, override = process.env.ONDA_VERSION) {
  const version = (override || readFileSync(join(root, "onda-version"), "utf8").split(/\r?\n/, 1)[0]).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Onda version '${version}'; set onda-version or ONDA_VERSION to major.minor.patch.`);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(readOndaVersion());
}
