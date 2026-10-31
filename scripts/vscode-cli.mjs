import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function vscodeCli(command = process.env.VSCODE_BIN || "code", platform = process.platform) {
  const env = { ...process.env };
  if (platform !== "win32") return { command, args: [], env };
  if (!isAbsolute(command)) {
    const found = spawnSync("where.exe", [command], { encoding: "utf8" });
    if (found.error) throw found.error;
    const executable = found.stdout?.split(/\r?\n/).find(file => /\.(?:cmd|exe)$/i.test(file));
    if (found.status !== 0 || !executable) throw new Error(`Could not find VS Code: ${command}`);
    command = executable;
  }
  if (!/\.cmd$/i.test(command)) return { command, args: [], env };
  // Run the standard Windows CLI through Electron, as code.cmd does. Passing
  // arguments directly preserves paths with spaces and shell metacharacters.
  const root = resolve(dirname(command), "..");
  const executable = join(root, "Code.exe");
  const cli = join(root, "resources", "app", "out", "cli.js");
  if (!existsSync(executable) || !existsSync(cli)) {
    throw new Error(`Unsupported VS Code launcher: ${command}. Set VSCODE_BIN to the VS Code executable.`);
  }
  return { command: executable, args: [cli], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}
