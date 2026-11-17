// The browser shell's archive implementations import node:zlib eagerly even
// when not registered. Native compression is deliberately not a Worker capability.
export const constants = {};
export function gunzipSync(): never { throw new Error("compression unavailable in this virtual shell"); }
export function gzipSync(): never { throw new Error("compression unavailable in this virtual shell"); }
