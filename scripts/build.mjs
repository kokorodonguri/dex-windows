// `tauri build` for the Rust host architecture, passed explicitly with
// --target. Without it the Tauri CLI names the bundles after the Node.js
// process architecture, e.g. an ARM64 binary in an "x64" installer when x64
// Node runs emulated on Windows on ARM.
// usage: node scripts/build.mjs [extra tauri build args]
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host:"))
  ?.slice(5)
  .trim();
if (!host) {
  console.error("could not determine the Rust host target (rustc -vV)");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = ["build", "--target", host, ...process.argv.slice(2)];
console.log(`> tauri ${args.join(" ")}`);
const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
