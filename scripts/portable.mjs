// Builds a portable (no-install) folder: portable/Modern DeX for PC/
//   ModernDeX.exe
//   bin/scrcpy-server
// The app looks for bin/ next to the executable (Tauri resource dir), and
// finds adb.exe via the usual lookup (Android SDK, PATH, or bin/adb.exe).
// usage: node scripts/portable.mjs [--skip-build]
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host:"))
  ?.slice(5)
  .trim();
if (!host) throw new Error("could not determine the Rust host target");

if (!process.argv.includes("--skip-build")) {
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const args = ["build", "--target", host, "--no-bundle"];
  console.log(`> tauri ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const release = join(root, "src-tauri", "target", host, "release");
const out = join(root, "portable", "Modern DeX for PC");
mkdirSync(join(out, "bin"), { recursive: true });

copyFileSync(join(release, "modern-dex.exe"), join(out, "ModernDeX.exe"));
const binSrc = join(root, "src-tauri", "resources", "bin");
if (!existsSync(join(binSrc, "scrcpy-server"))) {
  throw new Error("scrcpy-server missing: run `npm run fetch:bin` first");
}
for (const f of readdirSync(binSrc)) copyFileSync(join(binSrc, f), join(out, "bin", f));

console.log(`\nPortable app ready (${host}):\n  ${join(out, "ModernDeX.exe")}`);
