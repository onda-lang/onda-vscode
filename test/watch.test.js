const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { gpuFixture } = require("./helpers/gpuUi");

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Watch build did not update its output");
}

test("an incomplete staged GPU bundle preserves the previous build output", async t => {
  const { stageGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const { copyRunUi } = await import("../scripts/copy-run-ui.mjs");
  const f = await gpuFixture(t);
  fs.writeFileSync(path.join(f.root, "onda-version"), f.version);
  stageGpuUi(f.source, f.root);
  copyRunUi(f.root);
  fs.writeFileSync(path.join(f.root, "ui/gpu/host.js"), "partially staged bundle");
  assert.throws(() => copyRunUi(f.root), /asset changed since build/);
  assert.equal(fs.readFileSync(path.join(f.root, "out/gpu/host.js"), "utf8"), "test fixture\n");
});

test("watch builds include GPU assets and follow restaging and TypeScript edits", async t => {
  const { stageGpuUi } = await import("../scripts/stage-gpu-ui.mjs");
  const { watchExtension } = await import("../scripts/watch.mjs");
  const f = await gpuFixture(t);
  fs.writeFileSync(path.join(f.root, "onda-version"), f.version);
  fs.mkdirSync(path.join(f.root, "src"));
  const source = path.join(f.root, "src/extension.ts");
  fs.writeFileSync(source, "export const value = 1;\n");
  fs.writeFileSync(path.join(f.root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2020", types: [], outDir: "out" }, include: ["src"],
  }));
  stageGpuUi(f.source, f.root);
  const watching = watchExtension(f.root);
  t.after(() => watching.close());
  const script = path.join(f.root, "out/extension.js");
  const host = path.join(f.root, "out/gpu/host.js");
  await until(() => fs.existsSync(script) && fs.existsSync(host));
  assert.equal(fs.readFileSync(host, "utf8"), "test fixture\n");
  fs.writeFileSync(source, "export const value = 2;\n");
  await until(() => fs.readFileSync(script, "utf8").includes("value = 2"));

  // Staging replaces the entire ui/gpu directory, invalidating a watch on it.
  for (const revision of ["first restage", "second restage"]) {
    fs.writeFileSync(path.join(f.source, "host.js"), revision);
    f.manifest.files["host.js"] = createHash("sha256").update(revision).digest("hex");
    fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
    const obsolete = path.join(f.root, "out/gpu/obsolete.js");
    fs.writeFileSync(obsolete, "old bundle");
    stageGpuUi(f.source, f.root);
    await until(() => fs.readFileSync(host, "utf8") === revision);
    assert.equal(fs.existsSync(obsolete), false);
  }

  const staged = path.join(f.root, "ui/gpu");
  const revision = "edited staged asset";
  fs.writeFileSync(path.join(staged, "host.js"), revision);
  f.manifest.files["host.js"] = createHash("sha256").update(revision).digest("hex");
  fs.writeFileSync(path.join(staged, "pkg/build.json"), JSON.stringify(f.manifest));
  await until(() => fs.readFileSync(host, "utf8") === revision);
});
