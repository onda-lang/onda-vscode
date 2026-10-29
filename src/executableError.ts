import { OndaCompilerSource } from "./ondaExecutable";

export interface ExecutableErrorDescription {
  message: string;
  canConfigure: boolean;
}

export function describeOndaExecutableError(
  command: string,
  error: unknown,
  source: OndaCompilerSource = "external",
): ExecutableErrorDescription {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;

  if (code === "ENOENT" || /\bENOENT\b/.test(message)) {
    if (source === "bundled") {
      return {
        message:
          `The bundled Onda executable '${command}' was not found. `
          + "Reinstall the Onda extension for this platform, or select 'external' in "
          + "'onda.compiler.source' to use your own Onda installation.",
        canConfigure: true,
      };
    }
    return {
      message:
        `Onda executable '${command}' was not found. `
        + "Install Onda and add it to PATH, or set 'onda.server.path' to the executable's full path.",
      canConfigure: true,
    };
  }

  if (code === "EACCES" || /\bEACCES\b/.test(message)) {
    return {
      message:
        `Onda executable '${command}' could not be run because permission was denied. `
        + (source === "bundled"
          ? "Reinstall the Onda extension for this platform, or select 'external' in 'onda.compiler.source'."
          : "Check that the file is executable and that 'onda.server.path' points to the correct file."),
      canConfigure: true,
    };
  }

  return { message, canConfigure: false };
}
