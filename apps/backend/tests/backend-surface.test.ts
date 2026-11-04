import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { loadBackendConfig } from "../src/config";
import { createBackendServer } from "../src/server";
import { createConfiguredBackend } from "../src/main";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPwaProvisioningRuntime, type PwaProvisioningPlan } from "@recent-tx-safe-guard/security-core/pwa";
import { SubmissionJournal } from "../src/journal";

describe("backend public surface", () => {
  it("loads .env when started through pnpm dev", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-backend-dev-env-"));
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: { dev: string } };
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "package.json"), `${JSON.stringify({ type: "module", scripts: { dev: packageJson.scripts.dev } })}\n`);
    writeFileSync(join(directory, ".env"), "BACKEND_PROFILE=local\n");
    writeFileSync(join(directory, "src/main.ts"), "process.stdout.write(process.env.BACKEND_PROFILE ?? 'missing');\n");
    const env = { ...process.env };
    delete env.BACKEND_PROFILE;
    env.PATH = `${join(process.cwd(), "node_modules/.bin")}${delimiter}${env.PATH ?? ""}`;

    const child = spawnSync("pnpm", ["dev"], { cwd: directory, encoding: "utf8", env, timeout: 10_000 });

    expect(child.status).toBe(0);
    expect(child.stdout).toContain("local");
  });

  it("loads successor lineage only from the committed security-core artifact", () => {
    const provisionerSource = readFileSync(join(process.cwd(), "src/provisioner.ts"), "utf8");
    const backendSources = ["src/config.ts", "src/main.ts", "src/provisioner.ts", "src/server.ts"]
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");
    expect(provisionerSource).toContain("loadCommittedPwaProvisioningSuccessors");
    expect(provisionerSource).toMatch(/successors:\s*loadCommittedPwaProvisioningSuccessors\(\)/);
    expect(backendSources).not.toMatch(/BACKEND_[A-Z_]*SUCCESSOR/);
  });

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
      BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
    });
    const backend = await createConfiguredBackend(undefined, { ...config, port: 0 });
    await backend.close();
  });

  it("starts the HTTPS profile with automatic provisioning unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-backend-https-startup-"));
    const config = loadBackendConfig({
      BACKEND_PROFILE: "https", BACKEND_ORIGIN: "https://vault.example", BACKEND_RP_ID: "vault.example", BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`, BACKEND_RPC_URL: "https://sepolia.example.invalid", BACKEND_JOURNAL_PATH: join(directory, "journal.json"), BACKEND_PROVISIONING_JOURNAL_PATH: join(directory, "provisioning-journal.json"),
      BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
    });
    const backend = await createConfiguredBackend(undefined, { ...config, port: 0 });
    await backend.close();
  });

  it("fails startup closed on a pending provisioning prefix without contacting or exposing an RPC URL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-backend-pending-startup-"));
    const privateKey = `0x${"11".repeat(32)}` as const;
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = "https://secret-relay.example.invalid/private-token";
    const provisioningJournalPath = join(directory, "provisioning-journal.json");
    writeFileSync(provisioningJournalPath, `${JSON.stringify({
      chainId: 11155111,
      funder: account.address,
      entries: [{ id: "pwa-primary-signer", intentHash: `0x${"12".repeat(32)}`, transactionHash: `0x${"13".repeat(32)}`, nonce: 1, reserved: "1", status: "pending" }],
    })}\n`);
    const config = loadBackendConfig({
      BACKEND_PROFILE: "local", BACKEND_RELAY_PRIVATE_KEY: privateKey, BACKEND_RPC_URL: rpcUrl,
      BACKEND_JOURNAL_PATH: join(directory, "journal.json"), BACKEND_PROVISIONING_JOURNAL_PATH: provisioningJournalPath,
      BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
    });
    let message = "";
    try { await createConfiguredBackend(undefined, { ...config, port: 0 }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toMatch(/recovery validation failed closed/i);
    expect(message).not.toContain(rpcUrl);
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
