<h1>
  <img src="assets/png/onda-logo-dark-circle.png" alt="onda logo" width="40" align="absmiddle" /> Onda VS Code extension
</h1>

Language services, an embedded compiler, GPU run controls, and project creation/export
for [Onda](https://onda-lang.org). Supports `.onda`, `.on`, and `.ondaproject` files.

## Install

Requires VS Code 1.90 or newer. Install from the
[Microsoft Marketplace](https://marketplace.visualstudio.com/items?itemName=onda-lang.onda-vscode)
or [Open VSX](https://open-vsx.org/extension/onda-lang/onda-vscode), or use
**Extensions: Install from VSIX…** for a packaged build.

The compiler is included for Linux x64 and arm64, Windows x64, and macOS arm64;
a separate Onda installation is not required. Linux packages use the Debian 12
baseline (glibc 2.36 and PipeWire 0.3.65). The bundled macOS compiler declares
macOS 11.0 as its minimum; the installed VS Code version may require a newer OS.

## Commands

- **Onda: Run** opens the shared run UI for a source or project selected in the
  editor or Explorer. Saved source/dependency changes reload the running patch.
- **Onda: Run with Fast Math** enables `--fast-math` for that session, allowing
  floating-point optimizations that may change results. Regular **Onda: Run**
  returns to normal math.
- **Onda: Stop** stops playback.
- **Onda: Create Project…** creates an empty project or packages an active source.
- **Onda: Save as Project…** packages the active/running source and its currently
  bound buffer files into a new portable project directory.
- **Onda: Restart Language Server** restarts language services.

## Configuration

| Setting | Default / effect |
| --- | --- |
| `onda.compiler.source` | `bundled`; choose `external` to use a custom compiler. |
| `onda.server.path` | Used with `external`; unset finds `onda` on `PATH`. |
| `onda.server.args` | Empty; arguments before each compiler subcommand. |
| `onda.run.theme` | Unset (`null`) detects VS Code's appearance when the panel opens; accepts `dark` or `light`. |
| `onda.run.sampleRate` | 48,000 Hz for the next run. |
| `onda.run.blockSize` | 512 frames for the next run. |

The run panel's Settings changes sample rate, block size, and Fast Math immediately by
recompiling, preserving whether playback was running or stopped. Its ◐ button cycles
Dark / Light and saves the theme in VS Code settings. The button also appears in the unloaded view.

To use a custom compiler:

```json
{
  "onda.compiler.source": "external",
  "onda.server.path": "/path/to/onda"
}
```

Use an Onda build matching [onda-version](onda-version) so the compiler, control
protocol, and UI agree. Changing compiler source/path/arguments stops playback
and restarts the language server. The run panel's smoothing setting applies live
and survives source reloads.

One compiler serves the whole VS Code window. Set compiler source, path, and
arguments in **User** or **Workspace** settings. In a multi-root workspace, put
these settings in the `.code-workspace` file; individual folders cannot override
them. The compiler source and executable path are excluded from Settings Sync.

Language services watch saved source dependencies, including files outside the
workspace, and refresh diagnostics when dependencies change or missing files appear.
Parameter Reset restores defaults immediately, independently of smoothing.

Enum parameters use labelled dropdowns in the run panel. Reloading display labels
preserves the selected member; changing the enum type or member order resets the
selection to the new default.

## Development

Build the [GPU bundle in the Onda checkout](https://github.com/onda-lang/onda/blob/main/ui/gpu/README.md#browser-build-and-staging)
and obtain the matching extracted native release. From this repository:

```sh
npm ci
npm run stage:compiler -- /path/to/extracted-onda-release linux-x64
npm run stage:gpu -- /path/to/onda/ui/gpu
npm test
npm run package:embedded -- /path/to/extracted-onda-release linux-x64 onda.vsix
```

Use `linux-arm64`, `win32-x64`, or `darwin-arm64` on those hosts; staging executes
the compiler to verify its version and requires a matching host architecture.
Both staged bundles must match `onda-version`. Extension builds copy the generated
UI into `out/gpu`.

For a real extension-host/playback check, with VS Code available as `code` or
selected by `VSCODE_BIN`:

```sh
npm run test:gpu-host -- bundled
```

Pass a VSIX path as the second argument to test its installed contents. The test
uses a temporary profile and checks playback, parameter edits, panel visibility,
and source reload. `npm run test:compiler` separately checks the bundled CLI/LSP
without relying on an Onda installation on `PATH`.

`npm run test:integration` exercises the extension with real LSP, daemon, and playback
processes, including dependency recovery, exact integer controls, event payloads,
pending buffer edits across reloads, cancellation, and subprocess cleanup.
It uses the staged compiler by default and requires an
audio output device. Select a local compiler with
`npm run test:integration -- /path/to/onda`. To check packaged extension code and
its bundled compiler, run
`node scripts/test-run-integration.mjs bundled /path/to/extracted-vsix/extension`.

For development builds sharing a version number, restage the compiler after
rebuilding Onda. The compiler smoke test prints its executable checksum and checks
the current language features; matching version text alone does not identify a build.
