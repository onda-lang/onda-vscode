const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onda-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("reads the first line of onda-version with the plugin's whitespace handling", async t => {
  const { readOndaVersion } = await import("../scripts/onda-version.mjs");
  const root = temporary(t);
  fs.writeFileSync(path.join(root, "onda-version"), "  1.2.3  \r\n4.5.6\r\n");
  assert.equal(readOndaVersion(root, ""), "1.2.3");
});

test("ONDA_VERSION overrides the pin without requiring a version file", async t => {
  const { readOndaVersion } = await import("../scripts/onda-version.mjs");
  assert.equal(readOndaVersion(temporary(t), " 2.3.4 "), "2.3.4");
});

test("rejects invalid Onda release versions", async t => {
  const { readOndaVersion } = await import("../scripts/onda-version.mjs");
  const root = temporary(t);
  for (const value of ["", " ", "latest", "v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3/other"]) {
    fs.writeFileSync(path.join(root, "onda-version"), value);
    assert.throws(() => readOndaVersion(root, ""), /Invalid Onda version/);
  }
  assert.throws(() => readOndaVersion(root, "latest"), /Invalid Onda version/);
});

async function gpuFixture(t) {
  const { readOndaVersion } = await import("../scripts/onda-version.mjs");
  const root = temporary(t);
  const source = path.join(root, "onda/ui/gpu");
  const version = readOndaVersion();
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(root, "onda/Cargo.toml"), `[workspace]\nmembers = []\n\n[workspace.package]\nedition = "2021"\nversion = "${version}"\nlicense = "MIT"\n\n[workspace.lints.clippy]\nunwrap_used = "deny"\n`);
  const files = {};
  for (const name of [
    "index.html", "host.js", "browser.js", "protocol.js", "text-input.js", "pkg/onda_ui.js",
    "pkg/onda_ui_bg.wasm", "pkg/fonts/Inter.ttf", "pkg/fonts/JetBrainsMono.ttf",
    "pkg/OFL-Inter.txt", "pkg/OFL-JetBrainsMono.txt",
    "pkg/fonts/NotoEmoji.ttf", "pkg/fonts/NotoSansArabic.ttf",
    "pkg/fonts/NotoSansCJKsc-Regular.otf", "pkg/fonts/NotoSansHebrew.ttf",
    "pkg/OFL-NotoEmoji.txt", "pkg/OFL-NotoSansArabic.txt",
    "pkg/OFL-NotoSansCJK.txt", "pkg/OFL-NotoSansHebrew.txt",
  ]) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "test fixture\n");
    files[name] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  const manifestFile = path.join(source, "pkg/build.json");
  const manifest = { version, files };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { root, source, version, manifest, manifestFile };
}

test("stages GPU UI with its original build manifest", async t => {
  const { stageGpuUi, verifyGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const f = await gpuFixture(t);
  stageGpuUi(f.source, f.root);
  const staged = path.join(f.root, "ui/gpu");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staged, "pkg/build.json"), "utf8")), f.manifest);
  verifyGpuUi(staged);
  assert.throws(() => verifyGpuUi(staged, "0.0.0"), /expected 0.0.0/);
});

test("rejects an old GPU build even when the checkout version matches the pin", async t => {
  const { stageGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const f = await gpuFixture(t);
  const staged = path.join(f.root, "ui/gpu");
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "keep.txt"), "existing assets");
  fs.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, version: "0.0.0" }));
  assert.throws(() => stageGpuUi(f.source, f.root), /GPU UI is Onda 0.0.0/);
  assert.equal(fs.readFileSync(path.join(staged, "keep.txt"), "utf8"), "existing assets");
});

test("rejects an incomplete GPU UI bundle", async t => {
  const { stageGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const f = await gpuFixture(t);
  fs.unlinkSync(path.join(f.source, "pkg/OFL-Inter.txt"));
  assert.throws(() => stageGpuUi(f.source, f.root), /ENOENT/);
});

for (const name of ["pkg/onda_ui_bg.wasm", "pkg/onda_ui.js", "host.js", "pkg/fonts/Inter.ttf"]) {
  test(`rejects changed GPU asset ${name} before and after staging`, async t => {
    const { stageGpuUi, verifyGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
    const f = await gpuFixture(t);
    stageGpuUi(f.source, f.root);
    const staged = path.join(f.root, "ui/gpu");
    fs.appendFileSync(path.join(f.source, name), "changed");
    assert.throws(() => stageGpuUi(f.source, f.root), /asset changed since build/);
    verifyGpuUi(staged);
    fs.appendFileSync(path.join(staged, name), "changed");
    assert.throws(() => verifyGpuUi(staged), /asset changed since build/);
  });
}

test("rejects a GPU bundle without a build manifest", async t => {
  const { stageGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const f = await gpuFixture(t);
  fs.unlinkSync(f.manifestFile);
  assert.throws(() => stageGpuUi(f.source, f.root), /ENOENT/);
});

test("rejects incomplete or unsafe GPU build manifests", async t => {
  const { verifyGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const f = await gpuFixture(t);
  const missing = { ...f.manifest.files };
  delete missing["pkg/onda_ui_bg.wasm"];
  fs.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, files: missing }));
  assert.throws(() => verifyGpuUi(f.source), /manifest is missing/);
  for (const name of ["../outside.js", "/outside.js", "pkg/../outside.js", "pkg/fonts/..", "pkg\\outside.js"]) {
    fs.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest,
      files: { ...f.manifest.files, [name]: "0".repeat(64) },
    }));
    assert.throws(() => verifyGpuUi(f.source), /Invalid GPU UI build manifest entry/);
  }
});

for (const marker of [" ", "*"]) {
  test(`accepts release checksums with '${marker}' file markers`, async t => {
    const { verifyOndaArchive } = await import("../scripts/verify-onda-archive.mjs");
    const root = temporary(t);
    const name = "onda-1.2.3-linux-x64.tar.xz";
    const archive = path.join(root, name);
    const checksums = path.join(root, "SHA256SUMS.txt");
    fs.writeFileSync(archive, "compiler archive");
    const hash = createHash("sha256").update("compiler archive").digest("hex");
    fs.writeFileSync(checksums, `${hash} ${marker}${name}\r\n`);
    await verifyOndaArchive(archive, checksums);
    fs.appendFileSync(archive, "changed");
    await assert.rejects(verifyOndaArchive(archive, checksums), /checksum mismatch/);
  });
}

test("rejects checksum lists that do not cover the selected archive", async t => {
  const { verifyOndaArchive } = await import("../scripts/verify-onda-archive.mjs");
  const root = temporary(t);
  const archive = path.join(root, "selected.tar.xz");
  const checksums = path.join(root, "SHA256SUMS.txt");
  fs.writeFileSync(archive, "compiler archive");
  fs.writeFileSync(checksums, "0".repeat(64) + "  different.tar.xz\n");
  await assert.rejects(verifyOndaArchive(archive, checksums), /No valid checksum/);
});
