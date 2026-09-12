<h1>
  <img src="assets/svg/onda-logo-dark.svg" alt="onda logo" width="40" align="absmiddle" /> Onda VS Code extension
</h1>

This repo contains the VS Code extension for the [Onda](https://onda-lang.org) audio programming language.

It provides:

- `.onda`, `.on`, and `.ondaproject` filetype detection
- regex syntax highlighting
- builtin LSP startup through `onda lsp`
- `Onda: Run` which launches the embedded webview for a source or project
- project creation and source-only project export through `onda project`

## Requirements

- VS Code 1.90 or newer
- Onda 0.8.0 or newer
- an `onda` executable available on `PATH`, or an explicit configured path

## Install

This extension is available on Open VSX:

- https://open-vsx.org/extension/onda-lang/onda-vscode

### Option 1: install a `.vsix`

If you already have a packaged `.vsix`, install it with:

- VS Code Command Palette: `Extensions: Install from VSIX...`

### Option 2: build a `.vsix` locally from this repo

From the repo root:

```bash
npm install
npm run compile
npx @vscode/vsce package
```

That produces a `.vsix` file in the repo root, which you can then install like the packaged version.

## Configuration

By default the extension starts:

```text
onda lsp
```

You can configure the executable and run host in VS Code settings:

- `onda.server.path`
- `onda.server.args`
- `onda.run.host` (`webview` or `egui`)
- `onda.run.theme` (`auto`, `dark`, or `light`)
- `onda.run.sampleRate` (default: `48000` Hz)
- `onda.run.blockSize` (default: `256` frames)

Example settings:

```json
{
  "onda.server.path": "C:/path/to/onda.exe",
  "onda.server.args": [],
  "onda.run.sampleRate": 48000,
  "onda.run.blockSize": 256
}
```

Or on macOS/Linux:

```json
{
  "onda.server.path": "/path/to/onda"
}
```

The sample rate and block size are passed to both the embedded webview and
native egui run hosts. Changing either setting takes effect the next time you
run a file.

## Using the extension

Open an `.onda` or `.on` file and the extension will activate automatically.

Available commands:

- `Onda: Run`
- `Onda: Stop`
- `Onda: Create Project…`
- `Onda: Save as Project…`
- `Onda: Restart Language Server`

`Onda: Run` accepts `.onda`, `.on`, and `.ondaproject` files from the active editor or Explorer,
starts the run transport, and opens the run UI.

`Onda: Create Project…` creates an empty project or packages the active Onda source. `Onda: Save as
Project…` packages the active or running source together with buffer files currently bound in the
run panel. Both commands create a new portable project folder through the `onda project` CLI.
