import { afterEach, describe, expect, it } from "vitest";
import { createBackendServer } from "../src/server";
import type { BackendConfig } from "../src/config";
import { RebindSessionStore, RegistrationSessionStore } from "../src/session";

const config = {
  id: "local", host: "127.0.0.1", port: 0, chainId: 11155111, rpId: "localhost", origin: "http://localhost:5173",
  rpcUrl: "https://sepolia.example.invalid", relayPrivateKey: `0x${"11".repeat(32)}`, journalPath: "/tmp/backend-server-journal.json", provisioningJournalPath: "/tmp/backend-provisioning-journal.json",
  provisioningReviewDirectory: "/tmp/provisioning-reviews",
} satisfies BackendConfig;
const servers: ReturnType<typeof createBackendServer>[] = [];

async function runningServer() {
  const backend = createBackendServer(config, { autoProvisionVault: async () => { throw new Error("not used"); } });
  servers.push(backend);
  await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, () => resolve()).once("error", reject));
  const address = backend.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a port");
  return { backend, origin: `http://${config.host}:${address.port}` };
}

afterEach(async () => { await Promise.all(servers.splice(0).map((backend) => backend.close())); });

describe("backend HTTP boundary", () => {
  it("allows a cancelled registration prompt to retry but closes a registered role", () => {
    const sessions = new RegistrationSessionStore(config);
    const cancelled = sessions.create("primary");
    expect(sessions.create("primary").id).not.toBe(cancelled.id);
    sessions.markRegistered("primary");
    expect(() => sessions.create("primary")).toThrow(/already registered/i);
  });

  it("expires and consumes credential rebind sessions exactly once", () => {
    let now = 1_000;
    const sessions = new RebindSessionStore(config, () => now);
    const used = sessions.create("primary");
    expect(sessions.consume(used.id, "primary").role).toBe("primary");
    expect(() => sessions.consume(used.id, "primary")).toThrow(/unknown|used/i);
    const expired = sessions.create("secondary");
    now += 5 * 60_000 + 1;
    expect(() => sessions.consume(expired.id, "secondary")).toThrow(/expired/i);
  });

  it("reports readiness and no-store without exposing secrets", async () => {
    const { origin } = await runningServer();
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, provisioningReady: false, writesReady: false, chainId: 11155111, profileId: "local", origin: config.origin, rpId: "localhost" });
  });

  it("refreshes provisioning and write readiness from the handler's current state", async () => {
    let writesReady = false;
    const backend = createBackendServer(config, { autoProvisionVault: async () => ({}) as never, getReadiness: () => ({ provisioningReady: true, writesReady }) });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://${config.host}:${address.port}`;
    expect(await fetch(`${origin}/health`).then(r => r.json())).toMatchObject({ provisioningReady: true, writesReady: false });
    writesReady = true;
    expect(await fetch(`${origin}/health`).then(r => r.json())).toMatchObject({ provisioningReady: true, writesReady: true });
  });

  it("rejects wrong origin, malformed JSON, and unknown routes", async () => {
    const { origin } = await runningServer();
    const wrongOrigin = await fetch(`${origin}/health`, { headers: { Origin: "http://evil.invalid" } });
    expect(wrongOrigin.status).toBe(403);
    const malformed = await fetch(`${origin}/v1/registrations/primary/verify`, { method: "POST", headers: { Origin: config.origin, "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    const unknown = await fetch(`${origin}/v1/nope`, { headers: { Origin: config.origin } });
    expect(unknown.status).toBe(404);
  });

  it("permits only the exact HTTPS origin with credentialed CORS", async () => {
    const httpsConfig = { ...config, id: "https", origin: "https://vault.example", rpId: "vault.example" } satisfies BackendConfig;
    const backend = createBackendServer(httpsConfig, { autoProvisionVault: async () => { throw new Error("not used"); } });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, httpsConfig.host, () => resolve()).once("error", reject));
    const address = backend.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const origin = `http://${httpsConfig.host}:${address.port}`;

    const response = await fetch(`${origin}/health`, { headers: { Origin: httpsConfig.origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(httpsConfig.origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("routes only the closed automatic operation and removes the old plan/execute routes", async () => {
    const bodies: unknown[] = [];
    const backend = createBackendServer(config, {
      autoProvisionVault: async (body) => { bodies.push(body); return { ok: true } as never; },
    });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, () => resolve()).once("error", reject));
    const address = backend.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const origin = `http://${config.host}:${address.port}`;
    expect((await fetch(`${origin}/v1/vaults/auto-provision`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(`${origin}/v1/vaults/plan`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${origin}/v1/vaults`, { method: "POST", body: "{}" })).status).toBe(404);
    expect(bodies).toEqual([{}]);
  });

  it("routes role-specific recovered credential rebind and rejects fields, replay, wrong origin, and HTTPS", async () => {
    const stored: string[] = [];
    const backend = createBackendServer(config, {
      autoProvisionVault: async () => ({}) as never,
      rebindCoordinates: (role) => role === "primary" ? { x: 1n, y: 2n } : { x: 3n, y: 4n },
      verifyRebind: async (input) => ({ role: input.role, id: input.response.id, credentialId: input.response.id, publicKey: new Uint8Array([1]), counter: 1, ...input.coordinates }),
      storeReboundCredential: (credential) => { stored.push(credential.id); return { required: credential.role === "primary", primary: "ready", secondary: credential.role === "secondary" ? "ready" : "required" }; },
    });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://${config.host}:${address.port}`;
    const options = await fetch(`${origin}/v1/credentials/primary/rebind/options`, { method: "POST", headers: { Origin: config.origin, "content-type": "application/json" }, body: "{}" });
    expect(options.status).toBe(200);
    const session = await options.json() as { sessionId: string; challenge: string };
    const assertion = { id: "signed-credential-id", type: "public-key", response: {} };
    const verified = await fetch(`${origin}/v1/credentials/primary/rebind/verify`, { method: "POST", headers: { Origin: config.origin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.sessionId, assertion }) });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ role: "primary", credentialId: assertion.id });
    expect(stored).toEqual([assertion.id]);
    expect((await fetch(`${origin}/v1/credentials/primary/rebind/verify`, { method: "POST", headers: { Origin: config.origin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.sessionId, assertion }) })).status).toBe(400);
    expect((await fetch(`${origin}/v1/credentials/primary/rebind/options`, { method: "POST", headers: { Origin: config.origin, "content-type": "application/json" }, body: JSON.stringify({ credentialId: "browser-chosen" }) })).status).toBe(400);
    expect((await fetch(`${origin}/v1/credentials/primary/rebind/options`, { method: "POST", headers: { Origin: "http://evil.invalid", "content-type": "application/json" }, body: "{}" })).status).toBe(403);

    const httpsConfig = { ...config, id: "https", origin: "https://vault.example", rpId: "vault.example" } satisfies BackendConfig;
    const httpsBackend = createBackendServer(httpsConfig, { autoProvisionVault: async () => ({}) as never, rebindCoordinates: () => ({ x: 1n, y: 2n }) });
    servers.push(httpsBackend); await new Promise<void>((resolve, reject) => httpsBackend.server.listen(0, httpsConfig.host, resolve).once("error", reject));
    const httpsAddress = httpsBackend.server.address(); if (!httpsAddress || typeof httpsAddress === "string") throw new Error("missing port");
    expect((await fetch(`http://${httpsConfig.host}:${httpsAddress.port}/v1/credentials/primary/rebind/options`, { method: "POST", headers: { Origin: httpsConfig.origin, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("routes the closed prepare/submit/reconcile API with no-store responses", async () => {
    const hash = `0x${"aa".repeat(32)}` as const;
    const backend = createBackendServer(config, {
      autoProvisionVault: async () => ({}) as never,
      prepareTransfer: async (body) => ({ id: "request-1", requestHash: hash, safeTxHash: hash, kind: "base-transfer", requiredApprovals: ["primary"], publicRequest: body as Record<string, unknown> }),
      submit: async (_id, body) => ({ state: "awaiting-secondary", body }),
      submission: async () => ({ state: "uncertain", transactionHash: hash }),
    });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://${config.host}:${address.port}`;
    const prepared = await fetch(`${origin}/v1/submissions/prepare`, { method: "POST", body: JSON.stringify({ kind: "transfer", recipient: "0x1111111111111111111111111111111111111111", amount: "1000000n", idempotencyKey: "request-1" }) });
    expect(prepared.status).toBe(200); expect(prepared.headers.get("cache-control")).toBe("no-store"); expect(await prepared.json()).toMatchObject({ id: "request-1" });
    const submitted = await fetch(`${origin}/v1/submissions/request-1/submit`, { method: "POST", body: JSON.stringify({ role: "primary", assertion: { id: "p" } }) });
    expect(submitted.status).toBe(200); expect(submitted.headers.get("cache-control")).toBe("no-store");
    const status = await fetch(`${origin}/v1/submissions/request-1`); expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ state: "uncertain", transactionHash: hash });
  });

  it("decodes the browser's exact bigint queue nonce for every closed lifecycle intent", async () => {
    const hash = `0x${"aa".repeat(32)}` as const;
    const bodies: unknown[] = [];
    const backend = createBackendServer(config, {
      autoProvisionVault: async () => ({}) as never,
      prepareTransfer: async (body) => {
        const intent = body as { kind: "cancel-queued" | "execute-ready" | "skip-expired"; queueNonce: unknown };
        if (typeof intent.queueNonce !== "bigint") throw new Error("canonical bigint queue nonce is required");
        bodies.push(body);
        return { id: "lifecycle", requestHash: hash, safeTxHash: hash, kind: intent.kind, requiredApprovals: intent.kind === "cancel-queued" ? ["primary", "secondary"] : [], publicRequest: body as Record<string, unknown> };
      },
    });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://${config.host}:${address.port}`;
    for (const kind of ["cancel-queued", "execute-ready", "skip-expired"] as const) {
      const response = await fetch(`${origin}/v1/submissions/prepare`, {
        method: "POST", headers: { Origin: config.origin, "content-type": "application/json" },
        body: JSON.stringify({ kind, queueNonce: 9_007_199_254_740_993n, queueFingerprint: hash, idempotencyKey: `lifecycle-${kind}` }, (_key, value) => typeof value === "bigint" ? `${value}n` : value),
      });
      expect(response.status).toBe(200);
    }
    expect(bodies).toEqual(["cancel-queued", "execute-ready", "skip-expired"].map(kind => ({ kind, queueNonce: 9_007_199_254_740_993n, queueFingerprint: hash, idempotencyKey: `lifecycle-${kind}` })));
  });

  it("redacts provider endpoints and key-shaped values from HTTP errors", async () => {
    const backend = createBackendServer(config, { autoProvisionVault: async () => { throw new Error(`provider https://rpc.invalid/key failed ${"0x" + "11".repeat(32)}`); } });
    servers.push(backend); await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const response = await fetch(`http://${config.host}:${address.port}/v1/vaults/auto-provision`, { method: "POST", body: "{}" });
    expect(JSON.stringify(await response.json())).not.toMatch(/rpc\.invalid|1111111111/);
  });

  it("identifies pending confirmations as automatic exact-hash reconciliation", async () => {
    const backend = createBackendServer(config, { autoProvisionVault: async () => { throw new Error("automatic provisioning is still awaiting canonical confirmations for its recorded transaction"); } }, { log: () => undefined });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const response = await fetch(`http://${config.host}:${address.port}/v1/vaults/auto-provision`, { method: "POST", body: "{}" });
    expect(await response.json()).toMatchObject({ code: "provisioning_pending_confirmation", stage: "provisioning-reconciliation" });
  });

  it("correlates provisioning failures with a safe code, stage, and redacted structured log", async () => {
    const events: unknown[] = [];
    const backend = createBackendServer(
      config,
      { autoProvisionVault: async () => { throw new Error(`provisioning quote nonce mismatch for secondary-signer: expected 1032, observed 1033 via https://rpc.invalid/${"11".repeat(32)}`); } },
      { log: (event) => events.push(event) },
    );
    servers.push(backend); await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, resolve).once("error", reject));
    const address = backend.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const response = await fetch(`http://${config.host}:${address.port}/v1/vaults/auto-provision`, { method: "POST", body: "{}" });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ code: "provisioning_nonce_mismatch", stage: "provisioning-quote" });
    expect(payload.requestId).toBe(response.headers.get("x-request-id"));
    expect(JSON.stringify(payload)).not.toMatch(/rpc\.invalid|1111111111/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", status: 400, code: "provisioning_nonce_mismatch", stage: "provisioning-quote", route: "/v1/vaults/auto-provision", requestId: payload.requestId });
    expect(JSON.stringify(events[0])).not.toMatch(/rpc\.invalid|1111111111/);
  });
});
