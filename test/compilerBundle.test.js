const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function fixture(t, target = "linux-x64") {
  const bundle = await import("../scripts/compiler-bundle.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onda-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "compiler", target);
  const bytes = Buffer.alloc(256);
  if (target === "linux-x64") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(62, 18);
  } else if (target === "darwin-arm64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
  } else {
    bytes.write("MZ"); bytes.writeUInt32LE(128, 60);
    bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132);
  }
  const executable = path.join(directory, "bin", bundle.compilerTargets[target].executable);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, bytes);
  for (const name of [
    "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/LLVM-LICENSE.txt", "licenses/SLEEF-LICENSE.txt",
    ...["BLAKE3", "XXHASH", "MD5", "REGEX", "UNICODE", "MSVCSETUPAPI"].map(name => `licenses/LLVM-${name}-LICENSE.txt`),
    "licenses/RUST-DEPENDENCIES.txt", "licenses/MPL-2.0-SOURCES/README.txt",
  ]) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "test fixture\n");
  }
  const manifest = { version: bundle.compilerVersion, target, sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifestFile = path.join(root, "compiler", "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { ...bundle, root, directory, executable, manifest, manifestFile };
}

for (const target of ["linux-x64", "darwin-arm64", "win32-x64"]) {
  test(`accepts a complete ${target} bundle`, async t => {
    const f = await fixture(t, target);
    assert.deepEqual(f.verifyCompilerBundle(f.root, target), f.manifest);
  });
}

test("rejects platforms outside Onda's prebuilt release matrix", async () => {
  const { targetInfo } = await import("../scripts/compiler-bundle.mjs");
  for (const target of ["darwin-x64", "linux-arm64", "win32-arm64", "alpine-x64", "web", "toString"]) {
    assert.throws(() => targetInfo(target), /Unsupported compiler target/);
  }
});

test("staging cannot certify a compiler for another host from its directory name", async t => {
  const target = process.platform === "win32" ? "linux-x64" : "win32-x64";
  const f = await fixture(t, target);
  const { stageCompiler } = await import("../scripts/stage-compiler.mjs");
  const source = path.join(f.root, `onda-${f.compilerVersion}-${f.compilerTargets[target].release}`);
  fs.renameSync(f.directory, source);
  assert.throws(() => stageCompiler(source, target, f.root), /matching host/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifestFile, "utf8")), f.manifest);
});

test("rejects a VSIX target that differs from its compiler", async t => {
  const f = await fixture(t);
  assert.throws(() => f.verifyCompilerBundle(f.root, "win32-x64"), /does not match/);
});

test("rejects a different compiler version", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, version: "0.0.1" }));
  assert.throws(() => f.verifyCompilerBundle(f.root), /Bundled Onda must be/);
});

test("rejects a binary changed after staging", async t => {
  const f = await fixture(t);
  fs.appendFileSync(f.executable, "changed");
  assert.throws(() => f.verifyCompilerBundle(f.root), /checksum changed/);
});

test("rejects missing dependency notices", async t => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.directory, "licenses", "RUST-DEPENDENCIES.txt"));
  assert.throws(() => f.verifyCompilerBundle(f.root), /ENOENT/);
});

test("rejects a binary built for a different architecture", async t => {
  const f = await fixture(t);
  const bytes = fs.readFileSync(f.executable);
  bytes.writeUInt16LE(183, 18); // AArch64 ELF inside an x64 bundle.
  fs.writeFileSync(f.executable, bytes);
  assert.throws(() => f.verifyCompilerBundle(f.root), /binary does not match/);
});
