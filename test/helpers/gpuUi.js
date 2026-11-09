const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function gpuFixture(t) {
  const { readOndaVersion } = await import("../../scripts/onda-version.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onda-gpu-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "onda/ui/gpu");
  const version = readOndaVersion();
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(root, "onda/Cargo.toml"), `[workspace]\nmembers = []\n\n[workspace.package]\nedition = "2021"\nversion = "${version}"\nlicense = "Apache-2.0"\n\n[workspace.lints.clippy]\nunwrap_used = "deny"\n`);
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

module.exports = { gpuFixture };
