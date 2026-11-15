import { build } from "esbuild";
import { mkdir, copyFile, readdir, rm, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function command(bin: string, args: string[]) {
  const p = spawnSync(bin, args, { cwd: root, stdio: "inherit" });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(`${bin} failed`);
}
command("cargo", ["build", "--locked", "--manifest-path", "crates/roundhouse-core/Cargo.toml", "--target", "wasm32-unknown-unknown", "--release"]);
command("wasm-bindgen", ["crates/roundhouse-core/target/wasm32-unknown-unknown/release/roundhouse_core.wasm", "--out-dir", "npm/wasm", "--target", "web"]);
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await build({ entryPoints: ["src/client.ts", "src/core.ts", "src/node.ts", "src/workers.ts"], outdir: "dist", bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers", "node:*", "*.wasm"] });
command("bun", ["npm/node_modules/typescript/bin/tsc", "-p", "npm/tsconfig.json"]);
await copyFile(root + "LICENSE", root + "npm/LICENSE");
await copyFile(root + "crates/roundhouse-core/UPSTREAM.md", root + "npm/UPSTREAM.md");
await copyFile(root + "THIRD_PARTY_NOTICES.md", root + "npm/THIRD_PARTY_NOTICES.md");
// Supply the exact MPL-covered source even before a registry or source release.
await rm(root + "npm/rust", { recursive: true, force: true });
await mkdir(root + "npm/rust", { recursive: true });
for (const name of ["src", "tests", "Cargo.toml", "Cargo.lock", "README.md", "UPSTREAM.md", "LICENSE"]) await cp(root + "crates/roundhouse-core/" + name, root + "npm/rust/" + name, { recursive: true });
// Wasm redistributes compiled Rust dependencies; ship their actual notices too.
const metadata = spawnSync("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", "crates/roundhouse-core/Cargo.toml"], { cwd: root, encoding: "utf8" });
if (metadata.status !== 0) throw new Error("dependency metadata failed");
const graph: unknown = JSON.parse(metadata.stdout);
if (!graph || typeof graph !== "object" || !("packages" in graph) || !Array.isArray(graph.packages)) throw new Error("invalid dependency graph");
await rm(root + "npm/licenses", { recursive: true, force: true });
for (const p of graph.packages) {
  if (!p || typeof p !== "object" || typeof p.name !== "string" || typeof p.version !== "string" || typeof p.manifest_path !== "string" || typeof p.license !== "string") throw new Error("dependency license metadata missing");
  const directory = dirname(p.manifest_path);
  if (p.name === "rx4") {
    const source = join(root, "npm/rust/rotary");
    await mkdir(source, { recursive: true });
    for (const name of ["src", "Cargo.toml", "Cargo.lock", "LICENSE", "README.md"]) await cp(join(directory, name), join(source, name), { recursive: true });
  }
  const files = (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(f.name));
  if (!files.length) throw new Error(`dependency notices missing: ${p.name}`);
  const destination = join(root, "npm/licenses", `${p.name}-${p.version}`);
  await mkdir(destination, { recursive: true });
  for (const f of files) await copyFile(join(directory, f.name), join(destination, f.name));
}
const rust = spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" });
if (rust.status !== 0) throw new Error("Rust license location unavailable");
const rustNotices = join(rust.stdout.trim(), "share/doc/rust");
await mkdir(root + "npm/licenses/rust", { recursive: true });
await copyFile(join(rustNotices, "COPYRIGHT-library.html"), root + "npm/licenses/rust/COPYRIGHT-library.html");
for (const name of ["MIT.txt", "Apache-2.0.txt", "LLVM-exception.txt", "Unicode-3.0.txt"]) await copyFile(join(rustNotices, "licenses", name), root + "npm/licenses/rust/" + name);
