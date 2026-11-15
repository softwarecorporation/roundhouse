import module from "../wasm/roundhouse_core_bg.wasm";
import { initSync, roundhouse } from "../wasm/roundhouse_core.js";
import { bridge } from "./bridge.js";

initSync({ module });
export const core = bridge(roundhouse);
export type { Config, Monitor, Call } from "./types.js";
