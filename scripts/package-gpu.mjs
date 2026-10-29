import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || process.env.ONDA_GPU_UI_DIR;
if (!source) throw new Error('Usage: npm run package:gpu -- /path/to/onda/ui/gpu [output.vsix]');
const require = createRequire(import.meta.url);
function run(script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(resolve(root, 'scripts/stage-gpu-ui.mjs'), resolve(source));
// vsce runs vscode:prepublish, which compiles and copies the staged assets.
run(resolve(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce'),
  'package', '--out', resolve(process.argv[3] || 'onda-gpu.vsix'));
