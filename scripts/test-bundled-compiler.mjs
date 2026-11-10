import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compilerTargets, extensionRoot, verifyCompilerBundle } from "./compiler-bundle.mjs";

const root = resolve(process.argv[2] || extensionRoot);
const target = `${process.platform}-${process.arch}`;
const manifest = verifyCompilerBundle(root, target);
const command = join(root, "compiler", target, "bin", compilerTargets[target].executable);
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "onda-bundled-smoke-")));
// An absolute bundled executable must work without any Onda installation on PATH.
const env = { ...process.env, PATH: "", Path: "" };
const enumSource = join(workspace, "enums.onda");
const enumText = `enum Mode:
  LowPass
  HighPass {label = "High-pass"}
enum One:
  Only
params:
  mode = Mode::HighPass
  fixed = One::Only
  modes: Mode[2] = [Mode::LowPass, Mode::HighPass]
sample:
  out1 = i32(mode)
`;

function run(args) {
  const result = spawnSync(command, args, { cwd: workspace, env, encoding: "utf8", timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function testEventTransport() {
  const source = join(workspace, "events.onda");
  writeFileSync(source, "delegate report(value: f64)\nevent echo(value: f64 = -0.0):\n  report(value)\nsample:\n  out1 = 0.0\n");
  const requests = [
    {id:1,command:"run_metadata",path:source},
    {id:2,command:"run_start",path:source},
    {id:3,command:"run_trigger_event",path:source,name:"echo",values:["-0"]},
  ];
  const result = spawnSync(command, ["daemon", "stdio"], {
    cwd:workspace, env, encoding:"utf8", timeout:30000,
    input:requests.map(request => JSON.stringify(request) + "\n").join(""),
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, requests.length);
  for (let index = 0; index < replies.length; index++) {
    assert.equal(replies[index].id, index + 1);
    assert.equal(replies[index].ok, true, JSON.stringify(replies[index]));
  }
  assert.equal(replies[0].result.events[0].args[0].default, "-0");
  assert.equal(replies[2].result.delegate_occurrences[0].values.value, "-0");
}

async function testLanguageServer() {
  const child = spawn(command, ["lsp"], { cwd: workspace, env, stdio: "pipe" });
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let initialized = false;
  let completed = false;
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
        if (code === 0 && initialized && completed && shutdown) resolve();
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
              const uri = pathToFileURL(enumSource).href;
              send({ method: "textDocument/didOpen", params: {
                textDocument: { uri, languageId: "onda", version: 1, text: enumText },
              } });
              const prefix = enumText.slice(0, enumText.indexOf("Mode::HighPass") + "Mode::".length).split("\n");
              send({ id: 2, method: "textDocument/completion", params: {
                textDocument: { uri }, position: { line: prefix.length - 1, character: prefix.at(-1).length },
              } });
            } else if (message.id === 2) {
              const items = Array.isArray(message.result) ? message.result : message.result?.items;
              for (const label of ["LowPass", "HighPass"])
                assert.ok(items?.some(item => item.label === label && item.kind === 20), JSON.stringify(message));
              completed = true;
              send({ id: 3, method: "shutdown", params: null });
            } else if (message.id === 3) {
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
  writeFileSync(enumSource, enumText);
  const inputSource = join(workspace, "inputs.onda");
  writeFileSync(inputSource, "inputs:\n  freq = 440.0 {20.0, 20000.0, ramp = 0.02}\nsample:\n  out1 = freq\n");
  run(["compile", inputSource]);
  const enumMir = join(workspace, "enums.json");
  run(["compile", enumSource, "--emit", "mir-json", "--output", enumMir]);
  const params = JSON.parse(readFileSync(enumMir, "utf8")).interface.params;
  assert.equal(params[0].enumeration.members[1].label, "High-pass");
  assert.equal(params[1].enumeration.members.length, 1);
  assert.equal(params[2].enumeration.name, "Mode");
  run(["run", "render", source, "--dur", "0.01", "--output", join(workspace, "sine.wav")]);
  assert.equal(readFileSync(join(workspace, "sine.wav")).toString("ascii", 0, 4), "RIFF");
  const project = join(workspace, "project");
  run(["project", project, "--from", source]);
  assert.ok(readdirSync(project).some(name => name.endsWith(".ondaproject")));
  await testLanguageServer();
  testEventTransport();
  console.log(`Bundled Onda ${manifest.version} (${target}, ${manifest.sha256}): version, stdlib/object compilation, input smoothing, enum metadata, audio render, project export, LSP enum completion, and negative-zero daemon transport passed with PATH empty.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
