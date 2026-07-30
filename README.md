# Onda VSCode Extension

This extension adds VSCode support for Onda:

- `.onda` and `.on` language registration
- syntax highlighting
- semantic tokens from `onda lsp`
- `Onda: Run File`
- `Onda: Stop File`
- `Onda: Restart Language Server`

## Requirements

- VSCode 1.90 or newer
- Onda 0.5.0 or newer
- an `onda` executable available on `PATH`, or an explicit configured path

## Install

This extension is available on Open VSX:

- https://open-vsx.org/extension/onda-lang/onda-vscode

### Option 1: install a `.vsix`

If you already have a packaged `.vsix`, install it with one of these:

- VSCode Command Palette: `Extensions: Install from VSIX...`
- CLI:

```bash
code --install-extension onda-vscode-0.1.11.vsix
```

### Option 2: build a `.vsix` locally from this repo

From the repo root:

```bash
npm install
npm run compile
npx @vscode/vsce package
```

That produces a `.vsix` file in the repo root, which you can then install with:

```bash
code --install-extension ./onda-vscode-0.1.11.vsix
```

If you prefer the UI, use `Extensions: Install from VSIX...` and select the generated file.

## Configuration

By default the extension starts:

```text
onda lsp
```

You can configure the executable and run host in VSCode settings:

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
- `Onda: Run File`
- `Onda: Stop File`
- `Onda: Restart Language Server`

`Onda: Run File` starts the run transport and opens the run UI.

## Development

If you want to work on the extension itself:

```bash
npm install
npm run compile
```

Then open this repo in VSCode and launch an Extension Development Host.
