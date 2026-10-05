// Downloads the pinned scrcpy-server release and verifies its SHA-256.
// Usage: npm run fetch:bin [-- --force]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_VERSION = "4.1";
const SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SERVER_VERSION}/scrcpy-server-v${SERVER_VERSION}`;
const SERVER_SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "src-tauri", "resources", "bin");
const target = join(binDir, "scrcpy-server");
const force = process.argv.includes("--force");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  mkdirSync(binDir, { recursive: true });

  if (!force && existsSync(target) && sha256(readFileSync(target)) === SERVER_SHA256) {
    console.log(`scrcpy-server v${SERVER_VERSION} already present and verified: ${target}`);
    return;
  }

  console.log(`Downloading ${SERVER_URL}`);
  const res = await fetch(SERVER_URL, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== SERVER_SHA256) {
    throw new Error(`SHA-256 mismatch\n  expected ${SERVER_SHA256}\n  actual   ${actual}`);
  }
  writeFileSync(target, buf);
  console.log(`Saved ${buf.length} bytes to ${target} (sha256 ok)`);
}

main().catch((err) => {
  console.error(`fetch-binaries failed: ${err.message}`);
  process.exit(1);
});
