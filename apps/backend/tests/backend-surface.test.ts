import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { loadBackendConfig } from "../src/config";
import { createBackendServer } from "../src/server";
import { createConfiguredBackend } from "../src/main";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPwaProvisioningRuntime, type PwaProvisioningPlan } from "@recent-tx-safe-guard/security-core/pwa";
import { SubmissionJournal } from "../src/journal";

describe("backend public surface", () => {
  it("loads the real ESM entrypoint before validating backend configuration", () => {
    const child = spawnSync(process.execPath, [require.resolve("tsx/cli"), "src/main.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("BACKEND_PROFILE must be local or https");
  });

  it("exports backend names and keeps loopback Sepolia config explicit", () => {
    const config = loadBackendConfig({
      BACKEND_PROFILE: "local",
      BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      BACKEND_RPC_URL: "https://sepolia.example.invalid",
      BACKEND_JOURNAL_PATH: "/tmp/recent-tx-safe-guard/backend-journal.json",
      BACKEND_PROVISIONING_JOURNAL_PATH: "/tmp/recent-tx-safe-guard/provisioning-live-journal.json",
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
    const config = loadBackendConfig({
      BACKEND_PROFILE: "local", BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`, BACKEND_RPC_URL: "https://sepolia.example.invalid", BACKEND_JOURNAL_PATH: join(directory, "journal.json"), BACKEND_PROVISIONING_JOURNAL_PATH: join(directory, "provisioning-journal.json"),
      BACKEND_PROVISIONING_APPROVAL: join(directory, "approval.json"), BACKEND_PROVISIONING_APPROVAL_HASH_FILE: join(directory, "approval.sha256"), BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
    });
    const backend = await createConfiguredBackend(undefined, { ...config, port: 0 });
    await backend.close();
  });

  it("keeps provisioning and submission journals independently restartable", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-backend-journals-"));
    const provisioningPath = join(directory, "provisioning.json");
    const submissionPath = join(directory, "submissions.json");
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    writeFileSync(provisioningPath, `${JSON.stringify({ chainId: 11155111, funder: account.address, entries: [] })}\n`);
    const plan = { deployer: account.address } as unknown as PwaProvisioningPlan;
    const firstRuntime = createPwaProvisioningRuntime({ plan, journalPath: provisioningPath, account, client: {} });
    firstRuntime.close();
    const provisioningBytes = readFileSync(provisioningPath, "utf8");

    const requestHash = `0x${"12".repeat(32)}`;
    new SubmissionJournal(submissionPath).prepare("request-1", requestHash);

    const restartedRuntime = createPwaProvisioningRuntime({ plan, journalPath: provisioningPath, account, client: {} });
    restartedRuntime.close();
    expect(new SubmissionJournal(submissionPath).get("request-1")).toMatchObject({ state: "prepared", requestHash });
    expect(readFileSync(provisioningPath, "utf8")).toBe(provisioningBytes);
    expect(JSON.parse(readFileSync(submissionPath, "utf8"))).toEqual([{ id: "request-1", requestHash, publicRequest: {}, state: "prepared", approvals: { primary: false, secondary: false } }]);
  });
});
