const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function until(check, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function checkExternalDependencies(root) {
  const external = path.join(root, 'external', 'dependency.on');
  await fs.mkdir(path.dirname(external), {recursive:true});
  const valid = 'def dependency(x):\n  return x\n';
  await fs.writeFile(external, valid);
  const source = vscode.Uri.file(path.join(root, 'workspace', 'dependencies.onda'));
  const text = 'include "../external/dependency.on"\nsample:\n  out1 = dependency(0.0)\n';
  await fs.writeFile(source.fsPath, text);
  const document = await vscode.workspace.openTextDocument(source);
  await vscode.window.showTextDocument(document);
  await vscode.extensions.getExtension('onda-lang.onda-vscode').activate();
  await until(async () => (await vscode.commands.executeCommand('vscode.executeHoverProvider', source, new vscode.Position(2, 12)))?.length,
    'initial language services');
  await fs.writeFile(external, 'def renamed(x):\n  return x\n');
  await until(() => vscode.languages.getDiagnostics(source).some(d => d.message.includes("unknown function 'dependency'")),
    'external dependency diagnostics');
  await fs.writeFile(external, valid);
  await until(() => vscode.languages.getDiagnostics(source).length === 0, 'repaired external dependency');
  const missing = path.join(root, 'external', 'new', 'nested', 'created.on');
  const edited = new vscode.WorkspaceEdit();
  edited.replace(source, new vscode.Range(0, 0, document.lineCount, 0), text.replace('dependency.on', 'new/nested/created.on'));
  assert.ok(await vscode.workspace.applyEdit(edited));
  assert.ok(await document.save());
  await until(() => vscode.languages.getDiagnostics(source).length > 0, 'missing dependency diagnostics');
  await fs.mkdir(path.dirname(missing), {recursive:true});
  await fs.writeFile(missing, valid);
  await until(() => vscode.languages.getDiagnostics(source).length === 0, 'created dependency recovery');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await fs.writeFile(path.join(root, 'language-result.json'), JSON.stringify({passed:true,
    checks:['external dependency edit', 'external dependency repair', 'saved include change', 'missing parent creation', '.on dependency']}));
}

// Runs inside VS Code's real extension host. The outer CDP driver exercises
// the canvas; this side controls editor visibility and the playback lifecycle.
exports.run = async () => {
  const root = process.env.ONDA_GPU_HOST_TEST_DIR;
  assert.ok(root, 'Run through npm run test:gpu-host');
  await checkExternalDependencies(root);
  const source = vscode.Uri.file(path.join(root, 'workspace', 'host.onda'));
  assert.equal(vscode.workspace.workspaceFolders.length, 2, 'Exercise multi-root settings');
  const windowConfig = vscode.workspace.getConfiguration('onda');
  const folderConfig = vscode.workspace.getConfiguration('onda', source);
  for (const setting of ['compiler.source', 'server.path', 'server.args']) {
    assert.deepEqual(folderConfig.get(setting), windowConfig.get(setting),
      `${setting} must use the shared window compiler even with conflicting folder settings`);
  }
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
        assert.ok(['light','dark'].includes(theme));
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
