import * as path from "path";

export type OndaCompilerSource = "bundled" | "external";

export function resolveOndaExecutable(
  extensionPath: string,
  source: OndaCompilerSource,
  externalPath?: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (source === "external") {
    return externalPath?.trim() ? externalPath : "onda";
  }
  return path.join(
    extensionPath, "compiler", `${platform}-${arch}`, "bin",
    platform === "win32" ? "onda.exe" : "onda",
  );
}
