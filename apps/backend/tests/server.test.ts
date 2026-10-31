import { afterEach, describe, expect, it } from "vitest";
import { createBackendServer } from "../src/server";
import type { BackendConfig } from "../src/config";
import { RegistrationSessionStore } from "../src/session";

const config = {
  id: "local", host: "127.0.0.1", port: 0, chainId: 11155111, rpId: "localhost", origin: "http://localhost:5173",
  rpcUrl: "https://sepolia.example.invalid", relayPrivateKey: `0x${"11".repeat(32)}`, journalPath: "/tmp/backend-server-journal.json", reviewedArtifactsPath: "/tmp/reviewed.json",
  provisioningApprovalPath: "/tmp/provisioning-approval.json", provisioningReviewDirectory: "/tmp/provisioning-reviews",
} satisfies BackendConfig;
const servers: ReturnType<typeof createBackendServer>[] = [];

async function runningServer() {
  const backend = createBackendServer(config, { planVault: async () => { throw new Error("not used"); }, provisionVault: async () => { throw new Error("not used"); } });
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

  it("reports readiness and no-store without exposing secrets", async () => {
    const { origin } = await runningServer();
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, chainId: 11155111, profileId: "local", origin: config.origin, rpId: "localhost" });
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
    const backend = createBackendServer(httpsConfig, { planVault: async () => { throw new Error("not used"); }, provisionVault: async () => { throw new Error("not used"); } });
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

  it("routes planning separately from exact approved execution", async () => {
    const calls: string[] = [];
    const backend = createBackendServer(config, {
      planVault: async () => { calls.push("plan"); return { packageHash: `0x${"aa".repeat(32)}` }; },
      provisionVault: async () => { calls.push("execute"); return { ok: true } as never; },
    });
    servers.push(backend);
    await new Promise<void>((resolve, reject) => backend.server.listen(0, config.host, () => resolve()).once("error", reject));
    const address = backend.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const origin = `http://${config.host}:${address.port}`;
    expect((await fetch(`${origin}/v1/vaults/plan`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(`${origin}/v1/vaults`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(calls).toEqual(["plan", "execute"]);
  });
});
