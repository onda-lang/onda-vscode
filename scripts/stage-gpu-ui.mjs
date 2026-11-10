import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionRoot, readOndaVersion } from "./onda-version.mjs";

const assets = ["index.html", "host.js", "browser.js", "protocol.js", "text-input.js", "pkg"];
const requiredFiles = [
  ...assets.slice(0, -1), "pkg/onda_ui.js", "pkg/onda_ui_bg.wasm",
  "pkg/fonts/Inter.ttf", "pkg/fonts/JetBrainsMono.ttf",
  "pkg/OFL-Inter.txt", "pkg/OFL-JetBrainsMono.txt",
  "pkg/fonts/NotoEmoji.ttf", "pkg/fonts/NotoSansArabic.ttf",
  "pkg/fonts/NotoSansCJKsc-Regular.otf", "pkg/fonts/NotoSansHebrew.ttf",
  "pkg/OFL-NotoEmoji.txt", "pkg/OFL-NotoSansArabic.txt",
  "pkg/OFL-NotoSansCJK.txt", "pkg/OFL-NotoSansHebrew.txt",
];

export function verifyGpuUi(source = join(extensionRoot, "ui/gpu"), expectedVersion = readOndaVersion()) {
  const { version, files } = JSON.parse(readFileSync(join(source, "pkg/build.json"), "utf8"));
  if (version !== expectedVersion) {
    throw new Error(`GPU UI is Onda ${version}; expected ${expectedVersion}. Stage the UI from the matching Onda release.`);
  }
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Invalid GPU UI build manifest files");
  }
  for (const name of requiredFiles) {
    if (!Object.hasOwn(files, name)) throw new Error(`GPU UI build manifest is missing ${name}`);
  }
  for (const [name, hash] of Object.entries(files)) {
    if (!/^(?:[\w-]+\.html|[\w-]+\.js|pkg\/(?:fonts\/)?[\w.-]+)$/.test(name)
      || name.split("/").some(part => part === "." || part === "..")
      || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid GPU UI build manifest entry: ${name}`);
    }
    const bytes = readFileSync(join(source, name));
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw new Error(`GPU UI asset changed since build: ${name}. Rebuild the GPU UI.`);
    }
  }
  return version;
}

export function stageGpuUi(sourceDirectory, root = extensionRoot) {
  const source = resolve(sourceDirectory);
  const destination = join(root, "ui/gpu");
  if (source === destination) throw new Error("GPU UI source must differ from the staging directory.");
  const version = verifyGpuUi(source);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of assets) cpSync(join(source, name), join(destination, name), { recursive: true });
  console.log(`Staged GPU UI from Onda ${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2] || process.env.ONDA_GPU_UI_DIR;
  if (!source) throw new Error("Usage: npm run stage:gpu -- /path/to/onda/ui/gpu");
  stageGpuUi(source);
}
