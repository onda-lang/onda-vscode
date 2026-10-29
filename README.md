<h1>
  <img src="assets/png/onda-logo-dark-circle.png" alt="onda logo" width="40" align="absmiddle" /> Onda VS Code extension
</h1>

This repo contains the VS Code extension for the [Onda](https://onda-lang.org) audio programming language.

It provides:

- `.onda`, `.on`, and `.ondaproject` filetype detection
- regex syntax highlighting
- builtin LSP startup through `onda lsp`
- `Onda: Run` which opens the shared GPU run screen for a source or project
- project creation and source-only project export through `onda project`
- a bundled native Onda compiler for language services, playback, and project commands

## Requirements

- VS Code 1.90 or newer
- Linux x64, Windows x64, or macOS Apple Silicon

Platform VSIX packages include the compiler; no separate Onda installation or
`PATH` configuration is needed. In Remote SSH and other remote workspaces, the
extension and compiler run on the workspace host, which must use a supported
platform.
On Linux, the compiler also requires the system ALSA and PipeWire libraries
(`libasound.so.2` and `libpipewire-0.3.so.0`).

## Install

This extension is available on Open VSX:

- https://open-vsx.org/extension/onda-lang/onda-vscode

### Option 1: install a `.vsix`

If you already have a packaged `.vsix`, install it with:

- VS Code Command Palette: `Extensions: Install from VSIX...`

### Option 2: build a `.vsix` locally from this repo

From the repo root:

```bash
npm ci
# Build ui/gpu with npm run build:gpu-ui in the matching Onda checkout.
# Download and extract the matching Onda prebuilt release for this host.
npm run stage:compiler -- /path/to/extracted-onda-release linux-x64
npm run package:gpu -- /path/to/onda/ui/gpu
```

That produces `onda-gpu.vsix`, including the compiler, GPU renderer, fonts, and
dependency licenses. Use `win32-x64` on Windows or `darwin-arm64` on Apple Silicon.
Stage and package each target on a matching host so the executable's version can
be checked by running it. The VSIX declares its platform and cannot silently
fall back to an unrelated compiler on `PATH`.

`onda-version` pins both the compiler and GPU UI to Onda 0.9.0. Publish that
Onda release before running the extension packaging workflow. `ONDA_VERSION`
can override the pin for local builds. The GPU build records its version and
asset checksums in `pkg/build.json`; staging and packaging verify that manifest,
so changing the checkout version alone cannot relabel an old Wasm build.

## Configuration

The extension uses its bundled compiler by default. Settings include:

- `onda.compiler.source` (`bundled` or `external`)
- `onda.server.path` (used only with `external`; unset means `onda` on `PATH`)
- `onda.server.args` (arguments before every compiler subcommand)
- `onda.run.theme` (`auto`, `dark`, or `light`)
- `onda.run.sampleRate` (default: `48000` Hz)
- `onda.run.blockSize` (default: `512` frames)

To use a custom compiler:

```json
{
  "onda.compiler.source": "external",
  "onda.server.path": "C:/path/to/onda.exe",
  "onda.server.args": [],
  "onda.run.sampleRate": 48000,
  "onda.run.blockSize": 512
}
```

Or on macOS/Linux:

```json
{
  "onda.compiler.source": "external",
  "onda.server.path": "/path/to/onda"
}
```

Changing the compiler source, path, or arguments stops playback and restarts the
language server. The sample rate and block size are passed to the playback process. Changing
either setting takes effect the next time you run a file.

The panel runs the shared `onda_ui` Rust/wgpu screen as Wasm. It covers
parameters, input controls, buffers/waveforms, typed events, logs, MIDI, and
setup, with a collapsible scope. VS Code's webview API supplies the canvas
container and message transport.

For local development, build `ui/gpu` in the Onda source checkout with
`npm run build:gpu-ui`, then run `npm run stage:gpu -- /path/to/onda/ui/gpu`
and `npm run compile` here. Compilation requires the staged GPU assets.
Use `npm run stage:compiler` for the bundled compiler or select `external` while
developing. `npm test` checks the extension without requiring a staged compiler.

`npm run package:gpu -- /path/to/onda/ui/gpu [output.vsix]` stages the shared
assets and packages the staged compiler. Alternatively, with GPU assets already
staged, `npm run package:embedded -- /path/to/extracted-onda-release <target> [output.vsix]`
stages the compiler and packages both. Packaging checks the binary
architecture, checksum, version, required licenses, and GPU UI version.

The manual **Package embedded compiler** GitHub Actions workflow builds the GPU
UI from the pinned Onda tag, runs the extension tests, verifies release archive
checksums, and produces three platform VSIX artifacts. Each native runner tests
the compiler extracted from its VSIX with an empty `PATH`. It does not publish extensions.

`npm run test:compiler -- [extension-directory]` checks version, standard-library
compilation, offline audio rendering, project creation, and LSP startup with an
empty `PATH`. Pass an extracted VSIX's `extension` directory to test its contents.

`DISPLAY=:1 npm run test:gpu-host -- bundled [package.vsix]` runs the real
VS Code extension host and playback process in a temporary profile. With a VSIX,
it installs and tests that packaged copy. It verifies scope packets, numeric
editing confirmed by the audio processor, hidden-panel suspension, reopening,
and source reload. Screenshots and JSON evidence stay in the printed artifact
directory. Set `VSCODE_BIN` to use another VS Code installation.
Pass an executable path instead of `bundled` to test an external compiler.

The run panel's **Smooth** control adjusts parameter smoothing live. It starts at
30 ms; set it to 0 to disable smoothing, or double-click to restore 30 ms. The
chosen duration is preserved across source reloads and run restarts.

## Using the extension

Open an `.onda` or `.on` file and the extension will activate automatically.

Available commands:

- `Onda: Run`
- `Onda: Run with Fast Math`
- `Onda: Stop`
- `Onda: Create Project…`
- `Onda: Save as Project…`
- `Onda: Restart Language Server`

`Onda: Run` accepts `.onda`, `.on`, and `.ondaproject` files from the active editor or Explorer,
starts the run transport, and opens the run UI.

`Onda: Run with Fast Math` enables Onda's `--fast-math` compiler option for that
run session. Find it in the Command Palette or the file's Explorer
context menu. Fast math allows floating-point optimizations that can change
numerical results. The run header shows **Fast Math** while enabled. Saving the
source, changing devices, or using the panel's Play button keeps the session's
mode. Use regular `Onda: Run` to return to normal math. No setting is saved.

`Onda: Create Project…` creates an empty project or packages the active Onda source. `Onda: Save as
Project…` packages the active or running source together with buffer files currently bound in the
run panel. Both commands create a new portable project folder through the `onda project` CLI.

## Integration builds without an Onda release

Onda's **Build Onda Releases** workflow can call `package-embedded.yml` with a
pinned extension commit and unpublished native compiler and GPU UI artifacts
from the same run. Source revisions, archive checksums, and the pinned Onda
version are checked before packaging. The existing tests and packaged-compiler
checks run on Linux x64, Windows x64, and macOS ARM64; the resulting VSIX files
are downloadable workflow artifacts. Nothing is published to an extension
registry. Direct manual runs continue to use the published Onda version.
