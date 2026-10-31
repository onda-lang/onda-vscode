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

The compiler is included for Linux x64, Windows x64, and macOS arm64; a separate
Onda installation is not required.

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
| `onda.run.theme` | `auto`; also accepts `dark` or `light`. |
| `onda.run.sampleRate` | 48,000 Hz for the next run. |
| `onda.run.blockSize` | 512 frames for the next run. |

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

Use `win32-x64` or `darwin-arm64` on those hosts; staging executes the compiler to
verify its version and requires a matching host architecture. Both staged bundles
must match `onda-version`. Extension builds copy the generated UI into `out/gpu`.

For a real extension-host/playback check, with VS Code available as `code` or
selected by `VSCODE_BIN`:

```sh
npm run test:gpu-host -- bundled
```

Pass a VSIX path as the second argument to test its installed contents. The test
uses a temporary profile and checks playback, parameter edits, panel visibility,
and source reload. `npm run test:compiler` separately checks the bundled CLI/LSP
without relying on an Onda installation on `PATH`.
