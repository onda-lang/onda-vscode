<h1>
  <img src="assets/png/onda-logo-dark-circle.png" alt="onda logo" width="40" align="absmiddle" /> Onda VS Code extension
</h1>

VS Code extension for the [Onda](https://onda-lang.org) audio programming language. The extension ships with the embedded
compiler, which is used for both LSP support and compilation.

Supports `.onda`, `.on`, and `.ondaproject` files.

## Install

Install from the [Microsoft Marketplace](https://marketplace.visualstudio.com/items?itemName=onda-lang.onda-vscode)
or [Open VSX](https://open-vsx.org/extension/onda-lang/onda-vscode), or use
**Extensions: Install from VSIX…** for a packaged build.

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

| Setting | Default |
| --- | --- |
| `onda.compiler.source` | `bundled`; choose `external` to use a custom compiler. |
| `onda.exec.path` | Used with `external`; unset finds `onda` on `PATH`. |
| `onda.exec.args` | Empty; arguments before each compiler subcommand. |
| `onda.run.theme` | Unset (`null`) detects VS Code's appearance when the panel opens; accepts `dark` or `light`. |
| `onda.run.sampleRate` | 48,000 Hz for the next run. This can also be changed in the run window. |
| `onda.run.blockSize` | 512 frames for the next run. This can also be changed in the run window. |

To use a custom compiler:

```json
{
  "onda.compiler.source": "external",
  "onda.exec.path": "/path/to/onda"
}
```
