import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const npm = resolve(import.meta.dir, "..");
const archive = await realpath(resolve(process.argv[2] ?? resolve(npm, "tschk-roundhouse-0.2.0.tgz")));
const scratch = process.env.ROUNDHOUSE_TEST_SCRATCH ?? resolve(npm, "../../.amp/in/orb-backup");
await mkdir(scratch, { recursive: true });
const consumer = await mkdtemp(resolve(scratch, "roundhouse-package-"));
function run(args: string[], cwd: string, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Package consumer check failed: ${args[0]}`);
}

try {
  await writeFile(resolve(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(["add", "--ignore-scripts", archive], consumer);
  run(["install", "--frozen-lockfile", "--ignore-scripts"], consumer);
  const installed = await realpath(resolve(consumer, "node_modules/@tschk/roundhouse"));
  assert.ok(installed.startsWith(consumer + "/"), "archive must install inside the fresh consumer, not link to source");
  for (const path of ["dist/workers.js", "wasm/roundhouse_core_bg.wasm", "LICENSE", "rust/src/lib.rs", "licenses/rust/MIT.txt"]) {
    assert.ok((await readFile(resolve(installed, path))).length > 0, `missing packaged ${path}`);
  }
  await writeFile(resolve(consumer, "smoke.ts"), `
import { RoundhouseClient } from "@tschk/roundhouse";
import { core } from "@tschk/roundhouse/node";
const client = new RoundhouseClient({ url: "https://controller.test", token: "consumer-fixture" });
if (typeof client.incidents !== "function") throw new Error("client export missing");
const runtime: unknown = core.runtime();
if (JSON.stringify(runtime) !== JSON.stringify({agent:"rx4::lite::Agent",rotary_version:"0.8.0"})) throw new Error("wrong Rotary engine");
console.log("Installed client and Rotary Wasm exports passed");
`);
  run(["smoke.ts"], consumer);
  run([resolve(npm, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "smoke.ts"], consumer);
  // The harness stays in the source tree; all Worker modules come from the installed archive.
  run(["test", "test"], npm, { ...process.env, ROUNDHOUSE_PACKAGE_DIR: installed });
  console.log("Packed consumer passed: installed exports, declarations, actual workerd/Wasm, and approved native recovery");
} finally {
  await rm(consumer, { recursive: true, force: true });
}
