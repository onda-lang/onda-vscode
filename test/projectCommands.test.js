const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

function createProjectPanel() {
  const launches = [];
  const panel = createRunPanel(undefined, {
    modules: { child_process: { spawn(command, args) {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.killed = true; },
      });
      launches.push({ args, child });
      return child;
    } } },
  });
  panel.evaluate(`
    const source = vscode.Uri.file("/tmp/source.onda");
    const projectCommands = [];
    const projectErrors = [];
    let destinationPrompts = 0;
    let projectOpened = false;
    let sourceSaves = 0;
    activeOndaSourceUri = () => source;
    vscode.window.showQuickPick = async items => items[0];
    vscode.window.showErrorMessage = message => projectErrors.push(message);
    chooseProjectDestination = async () => {
      destinationPrompts++;
      return vscode.Uri.file("/tmp/export");
    };
    executeProjectCommand = async args => { projectCommands.push(args); return true; };
    offerToOpenProject = async () => { projectOpened = true; };
  `);
  return { ...panel, launches };
}

for (const command of ["createProject()", "saveAsProject(source)"]) {
  for (const state of ["clean", "closed", "dirty", "save failure"]) {
    test(`${command} handles a ${state} source`, async () => {
      const panel = createProjectPanel();
      if (state !== "closed") {
        panel.evaluate(`vscode.workspace.textDocuments.push({
          uri: source, isDirty: ${state !== "clean"},
          async save() { sourceSaves++; return ${state !== "save failure"}; },
        })`);
      }
      await panel.evaluate(command);
      const succeeded = state !== "save failure";
      assert.equal(panel.evaluate("destinationPrompts"), succeeded ? 1 : 0);
      assert.equal(panel.evaluate("projectOpened"), succeeded);
      assert.equal(panel.evaluate("sourceSaves"), ["dirty", "save failure"].includes(state) ? 1 : 0);
      if (succeeded) {
        assert.deepEqual(Array.from(panel.evaluate("projectCommands[0]")),
          ["project", "/tmp/export", "--from", "/tmp/source.onda"]);
        assert.equal(panel.evaluate("projectErrors.length"), 0);
      } else {
        assert.equal(panel.evaluate("projectCommands.length"), 0);
        assert.equal(panel.evaluate("projectErrors.length"), 1);
      }
    });
  }

  test(`${command} saves dirty playing code and reloads the run once`, async () => {
    const panel = createProjectPanel();
    await panel.evaluate('runFile(source, { fastMath: true })');
    panel.evaluate(`vscode.workspace.textDocuments.push({
      uri: source, isDirty: true,
      async save() {
        sourceSaves++;
        this.isDirty = false;
        await restartRunForSavedDocument(this);
        return true;
      },
    })`);
    await panel.evaluate(command);
    assert.equal(panel.evaluate("sourceSaves"), 1);
    assert.equal(panel.launches.length, 2);
    assert.equal(panel.launches[0].child.killed, true);
    assert.ok(panel.launches[1].args.includes("/tmp/source.onda"));
    assert.ok(panel.launches[1].args.includes("--fast-math"));
    assert.equal(panel.evaluate("projectOpened"), true);
    assert.equal(panel.evaluate("runInputSaves.size"), 0);
  });
}
