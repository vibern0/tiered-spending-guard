import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "../src/config";
import { createBackendServer } from "../src/server";
import { createConfiguredBackend } from "../src/main";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("backend public surface", () => {
  it("exports backend names and keeps loopback Sepolia config explicit", () => {
    const config = loadBackendConfig({
      BACKEND_PROFILE: "local",
      BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      BACKEND_RPC_URL: "https://sepolia.example.invalid",
      BACKEND_JOURNAL_PATH: "/tmp/recent-tx-safe-guard/backend-journal.json",
      BACKEND_REVIEWED_ARTIFACTS: "/tmp/recent-tx-safe-guard/reviewed-artifacts.json",
      BACKEND_PROVISIONING_APPROVAL: "/tmp/recent-tx-safe-guard/provisioning-approval.json",
      BACKEND_PROVISIONING_APPROVAL_HASH_FILE: "/tmp/recent-tx-safe-guard/provisioning-approval.sha256",
      BACKEND_PROVISIONING_REVIEW_DIRECTORY: "/tmp/recent-tx-safe-guard/provisioning-reviews",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.chainId).toBe(11155111);
    expect(typeof createBackendServer).toBe("function");
  });

  it("starts through the real entrypoint with the concrete internal provisioner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-backend-startup-"));
    const delayPath = join(directory, "delay.json");
    const reviewedPath = join(directory, "reviewed.json");
    writeFileSync(delayPath, "{}\n");
    writeFileSync(reviewedPath, JSON.stringify({
      formatVersion: 1,
      safeProxySaltNonce: "7",
      signerRuntimeCodeHash: `0x${"bb".repeat(32)}`,
      delayArtifactSourcePath: delayPath,
      profile: JSON.parse(readFileSync(resolve(process.cwd(), "../../packages/security-core/config/sepolia.pwa-phase-one.json"), "utf8")),
    }));
    const config = loadBackendConfig({
      BACKEND_PROFILE: "local", BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`, BACKEND_RPC_URL: "https://sepolia.example.invalid", BACKEND_JOURNAL_PATH: join(directory, "journal.json"), BACKEND_REVIEWED_ARTIFACTS: reviewedPath,
      BACKEND_PROVISIONING_APPROVAL: join(directory, "approval.json"), BACKEND_PROVISIONING_APPROVAL_HASH_FILE: join(directory, "approval.sha256"), BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
    });
    const backend = await createConfiguredBackend(undefined, { ...config, port: 0 });
    await backend.close();
  });
});
