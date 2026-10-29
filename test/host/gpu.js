const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

// Runs inside VS Code's real extension host. The outer CDP driver exercises
// the canvas; this side controls editor visibility and the playback lifecycle.
exports.run = async () => {
  const root = process.env.ONDA_GPU_HOST_TEST_DIR;
  assert.ok(root, 'Run through npm run test:gpu-host');
  const source = vscode.Uri.file(path.join(root, 'workspace', 'host.onda'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
  await vscode.commands.executeCommand('onda.runFile', source);
  await fs.writeFile(path.join(root, 'ready'), '');
  const deadline = Date.now() + 90000;
  let previous;
  while (Date.now() < deadline) {
    let request;
    try { request = JSON.parse(await fs.readFile(path.join(root, 'request.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (request && request.id !== previous) {
      previous = request.id;
      if (request.action === 'hide') {
        const document = await vscode.workspace.openTextDocument({ content: 'Hidden GPU panel test', language: 'plaintext' });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
      } else if (request.action === 'show') {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      } else if (request.action.startsWith('theme:')) {
        const theme = request.action.slice(6);
        assert.ok(['light','dark','auto'].includes(theme));
        await vscode.workspace.getConfiguration('onda').update('run.theme', theme, vscode.ConfigurationTarget.Workspace);
      } else if (request.action === 'workbenchLight') {
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Workspace);
      } else if (request.action === 'done') {
        await vscode.commands.executeCommand('onda.stopFile');
        assert.ok(!request.error, request.error);
        return;
      } else {
        throw new Error(`Unknown host-test action: ${request.action}`);
      }
      await fs.writeFile(path.join(root, 'ack.json'), JSON.stringify({ id: request.id }));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('GPU host driver did not finish');
};
