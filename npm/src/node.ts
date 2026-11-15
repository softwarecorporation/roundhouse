import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { initSync, roundhouse } from "../wasm/roundhouse_core.js";
import { bridge } from "./bridge.js";

initSync({ module: readFileSync(new URL("../wasm/roundhouse_core_bg.wasm", import.meta.url)) });
export const core = bridge(roundhouse);
export type { Config, Monitor, Call } from "./types.js";
