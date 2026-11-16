import { expect, test } from "bun:test";
import { RoundhouseClient } from "../src/client.js";

test("optional query values are omitted and telemetry cursors reach the server", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      return Response.json({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    },
  });
  try {
    const client = new RoundhouseClient({ url: server.url.toString(), token: "client-fixture" });
    expect(await client.telemetry({ service: undefined, since: undefined, before: "123", cursor: "record&one" })).toEqual({
      path: "/v1/telemetry", query: { before: "123", cursor: "record&one" },
    });
    expect(await client.analytics({ service: "app", kind: "event", name: "queued", since: undefined, bucket_seconds: undefined })).toEqual({
      path: "/v1/analytics", query: { service: "app", kind: "event", name: "queued" },
    });
  } finally {
    await server.stop(true);
  }
});
