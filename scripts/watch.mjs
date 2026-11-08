import { watch } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { copyRunUi } from "./copy-run-ui.mjs";

export function watchExtension(root = process.cwd()) {
  copyRunUi(root);
  let timer;
  let bundle;
  let closed = false;
  // stage:gpu replaces ui/gpu, so watch its surviving parent directory.
  // Reopen the recursive watch after a copy to follow the replacement tree.
  const update = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        copyRunUi(root);
        watchBundle();
        console.log("Updated Onda GPU UI.");
      } catch (error) {
        console.error(`GPU UI update failed: ${error.message}. Restage the complete GPU bundle to retry.`);
      }
    }, 100);
  };
  const watchBundle = () => {
    bundle?.close();
    bundle = watch(join(root, "ui/gpu"), { recursive: true }, update);
    bundle.on("error", update);
  };
  const assets = watch(join(root, "ui"), update);
  let compiler;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    assets.close();
    bundle?.close();
    compiler?.close();
  };
  assets.on("error", error => {
    console.error(`GPU UI watch failed: ${error.message}`);
    process.exitCode = 1;
    close();
  });
  try {
    watchBundle();
    compiler = ts.createWatchProgram(ts.createWatchCompilerHost(join(root, "tsconfig.json"), {}, ts.sys));
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const watching = watchExtension();
  process.once("SIGINT", watching.close);
  process.once("SIGTERM", watching.close);
}
