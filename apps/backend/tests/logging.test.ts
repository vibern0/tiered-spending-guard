import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  backendLogRoute,
  logBackendReady,
  logBackendStarting,
  observeBackendRequest,
  type BackendLogEvent,
} from "../src/logging";
import type { BackendConfig } from "../src/config";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const config = {
  host: "127.0.0.1",
  port: 0,
  origin: "http://localhost:5173",
  rpcUrl: "https://rpc.invalid/private-token",
  relayPrivateKey: `0x${"11".repeat(32)}`,
} as BackendConfig;

it("distinguishes startup from actual listening and reports the real bound port without secrets", async () => {
  const events: BackendLogEvent[] = [];
  const log = (event: BackendLogEvent) => {
    events.push(event);
  };
  const server = createServer();
  servers.push(server);
  logBackendStarting(config, log);
  expect(events).toEqual([
    expect.objectContaining({
      code: "backend_starting",
      host: "127.0.0.1",
      port: 0,
    }),
  ]);
  expect(() => logBackendReady(config, server, log)).toThrow("not listening");
  expect(events).toHaveLength(1);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  logBackendReady(config, server, log);
  const port = (server.address() as { port: number }).port;
  expect(events[1]).toMatchObject({
    code: "backend_ready",
    host: "127.0.0.1",
    port,
    url: `http://localhost:${port}`,
    allowedOrigin: config.origin,
    message: `Backend ready at http://localhost:${port}`,
  });
  expect(JSON.stringify(events)).not.toMatch(/rpc\.invalid|private-token|1111111111/);
});

it("logs long-running arrivals immediately and reports a disconnected client once", async () => {
  const events: BackendLogEvent[] = [];
  let received!: () => void;
  let aborted!: () => void;
  const arrival = new Promise<void>((resolve) => {
    received = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const server = createServer((req, res) => {
    observeBackendRequest(req, res, "test-request", (event) => {
      events.push(event);
      if (event.code === "request_received") received();
      if (event.code === "request_aborted") aborted();
    });
    // Keep the response open, as during a long confirmation wait.
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const port = (server.address() as { port: number }).port;
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/v1/vaults/auto-provision`, {
    method: "POST",
    signal: controller.signal,
  }).catch(() => undefined);
  await arrival;
  expect(events).toHaveLength(1);
  controller.abort();
  await request;
  await disconnected;
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    level: "warn",
    code: "request_aborted",
    requestId: "test-request",
    durationMs: expect.any(Number),
  });
  expect(events[1]).not.toHaveProperty("status");
});

it("redacts submission identifiers and never logs arbitrary paths", () => {
  expect(backendLogRoute("/v1/submissions/private-reference/submit?secret=never")).toBe(
    "/v1/submissions/:id/submit",
  );
  expect(backendLogRoute("/v1/submissions/private-reference")).toBe("/v1/submissions/:id");
  expect(backendLogRoute("/private-token")).toBe("unmatched");
});
