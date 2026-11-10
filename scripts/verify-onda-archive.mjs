import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyOndaArchive(archive, checksums) {
  const name = basename(archive);
  const entries = readFileSync(checksums, "utf8").split(/\r?\n/)
    .map(line => /^([0-9a-f]{64})[ \t]+\*?(.+)$/i.exec(line));
  const expected = entries.find(entry => entry && basename(entry[2]) === name)?.[1].toLowerCase();
  if (!expected) throw new Error(`No valid checksum for ${name} in ${checksums}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`Onda archive checksum mismatch: ${name}`);
  console.log(`Verified release checksum: ${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error("Usage: node scripts/verify-onda-archive.mjs <archive> <SHA256SUMS.txt>");
  }
  await verifyOndaArchive(process.argv[2], process.argv[3]);
}
