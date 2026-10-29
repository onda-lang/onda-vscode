import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compilerTargets, extensionRoot, verifyCompilerBundle } from "./compiler-bundle.mjs";

const root = resolve(process.argv[2] || extensionRoot);
const target = `${process.platform}-${process.arch}`;
const manifest = verifyCompilerBundle(root, target);
const command = join(root, "compiler", target, "bin", compilerTargets[target].executable);
const workspace = mkdtempSync(join(tmpdir(), "onda-bundled-smoke-"));
// An absolute bundled executable must work without any Onda installation on PATH.
const env = { ...process.env, PATH: "", Path: "" };

function run(args) {
  const result = spawnSync(command, args, { cwd: workspace, env, encoding: "utf8", timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function testLanguageServer() {
  const child = spawn(command, ["lsp"], { cwd: workspace, env, stdio: "pipe" });
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let initialized = false;
  let shutdown = false;
  const send = message => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Bundled LSP timed out")), 15000);
      child.once("error", reject);
      child.once("close", code => {
        clearTimeout(timeout);
        if (code === 0 && initialized && shutdown) resolve();
        else reject(new Error(`Bundled LSP exited ${code}: ${stderr}`));
      });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.stdin.on("error", reject);
      child.stdout.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          for (;;) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const match = /content-length:\s*(\d+)/i.exec(buffer.toString("ascii", 0, end));
            assert.ok(match, "LSP response must include Content-Length");
            const length = Number(match[1]);
            if (buffer.length < end + 4 + length) return;
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
            buffer = buffer.subarray(end + 4 + length);
            if (message.id === 1) {
              assert.ok(message.result?.capabilities, JSON.stringify(message));
              assert.equal(message.result.serverInfo.version, manifest.version);
              initialized = true;
              send({ method: "initialized", params: {} });
              send({ id: 2, method: "shutdown", params: null });
            } else if (message.id === 2) {
              assert.ok(!message.error, JSON.stringify(message));
              shutdown = true;
              send({ method: "exit", params: null });
              child.stdin.end();
            }
          }
        } catch (error) { reject(error); }
      });
      send({ id: 1, method: "initialize", params: { processId: process.pid, rootUri: null, capabilities: {} } });
    });
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

try {
  assert.equal(run(["--version"]).trim(), `Onda ${manifest.version}`);
  const source = join(workspace, "sine.onda");
  writeFileSync(source, "import std/osc\ninit:\n  osc = std::osc::Sine()\nsample:\n  out1 = osc(freq = 440.0)\n");
  run(["compile", source, "--emit", "obj", "--output", join(workspace, "sine.o")]);
  assert.ok(statSync(join(workspace, "sine.o")).size > 0);
  run(["run", "render", source, "--dur", "0.01", "--output", join(workspace, "sine.wav")]);
  assert.equal(readFileSync(join(workspace, "sine.wav")).toString("ascii", 0, 4), "RIFF");
  const project = join(workspace, "project");
  run(["project", project, "--from", source]);
  assert.ok(readdirSync(project).some(name => name.endsWith(".ondaproject")));
  await testLanguageServer();
  console.log(`Bundled Onda ${manifest.version} (${target}): version, stdlib/object compilation, audio render, project export, and LSP passed with PATH empty.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
