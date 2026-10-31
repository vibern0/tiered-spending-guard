import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "../src/config";
import { createBackendServer } from "../src/server";

describe("backend public surface", () => {
  it("exports backend names and keeps loopback Sepolia config explicit", () => {
    const config = loadBackendConfig({
      BACKEND_PROFILE: "local",
      BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      BACKEND_RPC_URL: "https://sepolia.example.invalid",
      BACKEND_JOURNAL_PATH: "/tmp/recent-tx-safe-guard/backend-journal.json",
      BACKEND_REVIEWED_ARTIFACTS: "/tmp/recent-tx-safe-guard/reviewed-artifacts.json",
      BACKEND_PROVISIONER_MODULE: "/tmp/recent-tx-safe-guard/provisioner.mjs",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.chainId).toBe(11155111);
    expect(typeof createBackendServer).toBe("function");
  });
});
