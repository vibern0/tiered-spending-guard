import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "../src/config";

const valid = {
  BACKEND_PROFILE: "local",
  BACKEND_ORIGIN: "http://localhost:5173",
  BACKEND_RP_ID: "localhost",
  BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  BACKEND_RPC_URL: "https://sepolia.example.invalid",
  BACKEND_JOURNAL_PATH: "/tmp/recent-tx-safe-guard/backend-journal.json",
  BACKEND_REVIEWED_ARTIFACTS: "/tmp/recent-tx-safe-guard/reviewed-artifacts.json",
  BACKEND_PROVISIONER_MODULE: "/tmp/recent-tx-safe-guard/provisioner.mjs",
};

describe("backend configuration", () => {
  it("requires every write-boundary input", () => {
    expect(loadBackendConfig(valid)).toMatchObject({
      id: "local",
      origin: "http://localhost:5173",
      rpId: "localhost",
      reviewedArtifactsPath: valid.BACKEND_REVIEWED_ARTIFACTS,
    });
    for (const key of Object.keys(valid).filter((key) => key !== "BACKEND_ORIGIN" && key !== "BACKEND_RP_ID")) {
      const env = { ...valid };
      delete env[key as keyof typeof env];
      expect(() => loadBackendConfig(env), key).toThrow(key);
    }
  });

  it("requires every HTTPS identity field and rejects unsafe profile combinations", () => {
    const https = {
      ...valid,
      BACKEND_PROFILE: "https",
      BACKEND_ORIGIN: "https://vault.example",
      BACKEND_RP_ID: "vault.example",
    };
    expect(loadBackendConfig(https)).toMatchObject({ id: "https", origin: "https://vault.example", rpId: "vault.example" });
    for (const key of ["BACKEND_ORIGIN", "BACKEND_RP_ID"] as const) {
      const env = { ...https };
      delete env[key];
      expect(() => loadBackendConfig(env), key).toThrow(key);
    }
    expect(() => loadBackendConfig({ ...https, BACKEND_ORIGIN: "https://evil.example" })).toThrow(/RP ID|origin/i);
    expect(() => loadBackendConfig({ ...https, BACKEND_ORIGIN: "http://vault.example" })).toThrow(/HTTPS/i);
    expect(() => loadBackendConfig({ ...https, BACKEND_ORIGIN: "https://user@vault.example" })).toThrow();
    expect(() => loadBackendConfig({ ...https, BACKEND_RP_ID: "192.0.2.1", BACKEND_ORIGIN: "https://192.0.2.1" })).toThrow(/RP.?ID/i);
    expect(() => loadBackendConfig({ ...https, BACKEND_RP_ID: "preview-vault.example", BACKEND_ORIGIN: "https://preview-vault.example" })).toThrow(/preview/i);
    expect(() => loadBackendConfig({ ...https, BACKEND_PROFILE: "preview" })).toThrow(/BACKEND_PROFILE/);
  });
});
