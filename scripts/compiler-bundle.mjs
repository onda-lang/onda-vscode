import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionRoot, readOndaVersion } from "./onda-version.mjs";

export { extensionRoot };
export const compilerVersion = readOndaVersion();

// Keep this aligned with Onda's prebuilt release matrix.
export const compilerTargets = {
  "win32-x64": { release: "windows-x64", executable: "onda.exe", format: "pe", runner: "windows-latest", extension: "zip" },
  "linux-x64": { release: "linux-x64", executable: "onda", format: "elf", runner: "ubuntu-24.04", extension: "tar.xz" },
  "darwin-arm64": { release: "macos-arm64", executable: "onda", format: "macho", runner: "macos-latest", extension: "tar.xz" },
};

const requiredLicenses = [
  "LLVM-LICENSE.txt", "SLEEF-LICENSE.txt", "LLVM-BLAKE3-LICENSE.txt",
  "LLVM-XXHASH-LICENSE.txt", "LLVM-MD5-LICENSE.txt", "LLVM-REGEX-LICENSE.txt",
  "LLVM-UNICODE-LICENSE.txt", "LLVM-MSVCSETUPAPI-LICENSE.txt",
  "RUST-DEPENDENCIES.txt", "MPL-2.0-SOURCES/README.txt",
];

export function targetInfo(target) {
  if (!Object.hasOwn(compilerTargets, target)) {
    throw new Error(`Unsupported compiler target '${target}'. Supported: ${Object.keys(compilerTargets).join(", ")}`);
  }
  return compilerTargets[target];
}

export function requireFile(file) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Required compiler file is empty or not a file: ${file}`);
  }
}

export function verifyCompilerFiles(directory, target) {
  const info = targetInfo(target);
  const executable = join(directory, "bin", info.executable);
  requireFile(executable);
  const bytes = readFileSync(executable);
  const valid = info.format === "elf"
    ? bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62
    : info.format === "macho"
      ? bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c
      : isWindowsX64(bytes);
  if (!valid) throw new Error(`Compiler binary does not match ${target}: ${executable}`);
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", ...requiredLicenses.map(name => `licenses/${name}`)]) {
    requireFile(join(directory, file));
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function isWindowsX64(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return false;
  const offset = bytes.readUInt32LE(60);
  return offset <= bytes.length - 6 && bytes.toString("ascii", offset, offset + 4) === "PE\0\0"
    && bytes.readUInt16LE(offset + 4) === 0x8664;
}

export function verifyCompilerBundle(root = extensionRoot, expectedTarget) {
  const directory = join(root, "compiler");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  targetInfo(manifest.target);
  if (manifest.version !== compilerVersion) {
    throw new Error(`Bundled Onda must be ${compilerVersion}; found ${manifest.version}. Stage the matching release.`);
  }
  if (expectedTarget && manifest.target !== expectedTarget) {
    throw new Error(`VSIX target ${expectedTarget} does not match bundled compiler ${manifest.target}.`);
  }
  const hash = verifyCompilerFiles(join(directory, manifest.target), manifest.target);
  if (hash !== manifest.sha256) throw new Error("Bundled compiler checksum changed; stage the compiler again.");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ include: Object.entries(compilerTargets).map(([target, info]) => ({ target, ...info })) }));
}
