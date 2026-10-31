const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("Windows code.cmd uses Electron's CLI without a shell", async t => {
  const { vscodeCli } = await import("../scripts/vscode-cli.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onda VS Code & CLI-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, "bin", "code.cmd");
  const executable = path.join(root, "Code.exe");
  const cli = path.join(root, "resources", "app", "out", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(executable, "fixture");
  fs.writeFileSync(cli, "fixture");
  const launch = vscodeCli(shim, "win32");
  assert.equal(launch.command, executable);
  assert.deepEqual(launch.args, [cli]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(launch.shell, undefined);
  fs.unlinkSync(cli);
  assert.throws(() => vscodeCli(shim, "win32"), /Set VSCODE_BIN/);
});

test("native VS Code executables and Unix launchers retain their arguments", async () => {
  const { vscodeCli } = await import("../scripts/vscode-cli.mjs");
  for (const platform of ["linux", "darwin", "win32"]) {
    const command = path.resolve("VS Code & tools", "Code.exe");
    const launch = vscodeCli(command, platform);
    assert.equal(launch.command, command);
    assert.deepEqual(launch.args, []);
  }
  assert.equal(vscodeCli("code", "linux").command, "code");
});
