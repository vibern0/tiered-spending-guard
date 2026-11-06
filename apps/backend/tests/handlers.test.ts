import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createBackendHandlers } from "../src/handlers";
import type { BackendConfig } from "../src/config";
import type { BackendPreparedSubmission } from "../src/vault";
import type { AutomaticPwaProvisioner } from "../src/provisioner";
import type { VerifiedPasskeyApproval } from "../src/webauthn";
import type { PwaProvisioningPlan, PwaProvisioningResult } from "@recent-tx-safe-guard/security-core/pwa";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const DELAY = "0x3333333333333333333333333333333333333333" as Address;
const PRIMARY = "0x4444444444444444444444444444444444444444" as Address;
const SECONDARY = "0x5555555555555555555555555555555555555555" as Address;
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const FORGED_USDC = "0x7777777777777777777777777777777777777777" as Address;
const HASH = `0x${"aa".repeat(32)}` as Hex;
const config = {
  id: "local", host: "127.0.0.1", port: 8787, chainId: 11155111, rpId: "localhost", origin: "http://localhost:5173",
  rpcUrl: "https://sepolia.example.invalid", relayPrivateKey: `0x${"11".repeat(32)}`, journalPath: "/tmp/backend-journal.json", provisioningJournalPath: "/tmp/backend-provisioning-journal.json",
  provisioningReviewDirectory: "/tmp/provisioning-reviews",
} satisfies BackendConfig;
const result = { chainId: 11155111, safe: SAFE, guard: GUARD, delay: DELAY, primaryPasskey: PRIMARY, secondaryPasskey: SECONDARY, usdc: USDC, evidence: { setupTransactionHash: HASH, verificationReportHash: HASH, deploymentsHash: HASH, policyHash: HASH } } as const;
const verified = { chainId: 11155111, safe: SAFE, guard: GUARD, delay: DELAY, primaryPasskey: PRIMARY, secondaryPasskey: SECONDARY, usdc: USDC, deploymentsHash: HASH, policyHash: HASH, setupReceipt: { transactionHash: HASH, blockNumber: 1n }, topologyReportHash: HASH } as const satisfies PwaProvisioningResult;
const completion = { response: result, verified } as const;
const publicKey = (fill: number) => Uint8Array.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...new Uint8Array(32).fill(fill), 0x22, 0x58, 0x20, ...new Uint8Array(32).fill(fill + 1)]);
const credential = (role: "primary" | "secondary", id: string, fill: number, counter = 0) => ({ role, id, credentialId: id, publicKey: publicKey(fill), counter, x: BigInt(fill), y: BigInt(fill + 1) });

describe("server-authoritative backend handlers", () => {
  it("binds recovered credentials discovered after an unresolved startup without restarting the server", async () => {
    let recovered: AutomaticPwaProvisioner["recoveryCredentials"];
    const expected = { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } };
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { get recoveryCredentials() { return recovered; }, provision: async () => { recovered = expected; return completion; } } });
    const response = await handlers.autoProvisionVault({});
    expect(response.credentialRebind).toEqual({ required: true, primary: "required", secondary: "required" });
    expect(handlers.rebindCoordinates("primary")).toEqual(expected.primary);
    expect(handlers.rebindCoordinates("secondary")).toEqual(expected.secondary);
    handlers.storeReboundCredential(credential("primary", "p", 1));
    handlers.storeReboundCredential(credential("secondary", "s", 3));
    expect(handlers.credentialRebindStatus().required).toBe(false);
  });
  it("rejects mismatching registrations that arrive while asynchronous recovery discovers the configured keys", async () => {
    let recovered: AutomaticPwaProvisioner["recoveryCredentials"];
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const handlers = createBackendHandlers({ config, usdc: USDC, prepareTransfer: vi.fn(), submit: vi.fn(), submission: vi.fn(), provisioner: { get recoveryCredentials() { return recovered; }, provision: async () => { await wait; recovered = { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } }; return completion; } } });
    const pending = handlers.autoProvisionVault({});
    handlers.storeCredential(credential("primary", "wrong-p", 11));
    handlers.storeCredential(credential("secondary", "wrong-s", 13));
    release();
    await expect(pending).rejects.toThrow(/recovered role keys/);
    expect(handlers.getReadiness?.().writesReady).toBe(false);
    expect(handlers.credentialRebindStatus()).toMatchObject({ primary: "required", secondary: "required" });
    expect(handlers.currentVault?.()).toBeUndefined();
  });
  it("keeps fresh provisioning ready while sending waits for a vault, both factors, and every runtime callback", async () => {
    const callbacks = { prepareTransfer: vi.fn(), submit: vi.fn(), submission: vi.fn() };
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { provision: vi.fn().mockResolvedValue(completion) }, ...callbacks });
    expect(handlers.getReadiness?.()).toEqual({ provisioningReady: true, writesReady: false });
    handlers.storeCredential(credential("primary", "p", 1));
    expect(handlers.getReadiness?.().writesReady).toBe(false);
    handlers.storeCredential(credential("secondary", "s", 3));
    expect(handlers.getReadiness?.().writesReady).toBe(false);
    await handlers.autoProvisionVault({});
    expect(handlers.getReadiness?.()).toEqual({ provisioningReady: true, writesReady: true });

    const missingRuntime = createBackendHandlers({ config, usdc: USDC, provisioner: { provision: vi.fn().mockResolvedValue(completion) } });
    missingRuntime.storeCredential(credential("primary", "p", 1));
    missingRuntime.storeCredential(credential("secondary", "s", 3));
    await missingRuntime.autoProvisionVault({});
    expect(missingRuntime.getReadiness?.()).toEqual({ provisioningReady: true, writesReady: false });
  });

  it("retains the original provisioning plan only in the server-held vault record", async () => {
    const plan = { planHash: HASH, transactions: [] } as unknown as PwaProvisioningPlan;
    const prepare = vi.fn(async ({ request }): Promise<BackendPreparedSubmission> => ({ id: request.idempotencyKey, requestHash: HASH, safeTxHash: HASH, kind: "base-transfer", requiredApprovals: ["primary"], publicRequest: request }));
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { provision: vi.fn().mockResolvedValue({ ...completion, plan }) }, prepareTransfer: prepare });
    handlers.storeCredential(credential("primary", "p", 1));
    handlers.storeCredential(credential("secondary", "s", 3));
    const response = await handlers.autoProvisionVault({});
    expect(handlers.vaultRecord()?.provisioningPlan).toBe(plan);
    expect(response).not.toHaveProperty("provisioningPlan");
    expect(response).not.toHaveProperty("plan");
    expect(handlers.currentVault?.()).not.toHaveProperty("provisioningPlan");
    await handlers.prepareTransfer({ kind: "transfer", recipient: SAFE, amount: 1n, idempotencyKey: "plan-1" });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ vault: expect.objectContaining({ provisioningPlan: plan, verifiedProvisioning: verified }) }));
  });
  it("auto-provisions from stored credentials, single-flights duplicates, and rejects every browser field", async () => {
    let release: ((value: typeof completion) => void) | undefined;
    const pending = new Promise<typeof completion>((resolve) => { release = resolve; });
    const provision = vi.fn().mockReturnValue(pending);
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { provision } satisfies AutomaticPwaProvisioner });
    handlers.storeCredential(credential("primary", "primary-credential", 1));
    handlers.storeCredential(credential("secondary", "secondary-credential", 3));

    const forbidden = ["address", "safe", "guard", "delay", "usdc", "token", "recipient", "policy", "signer", "nonce", "fee", "artifact", "runtimeHash", "approval"];
    for (const field of forbidden) await expect(handlers.autoProvisionVault({ [field]: FORGED_USDC })).rejects.toThrow(/field/i);
    const first = handlers.autoProvisionVault({});
    const second = handlers.autoProvisionVault({});
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({ primary: expect.objectContaining({ id: "primary-credential", x: 1n, y: 2n }), secondary: expect.objectContaining({ id: "secondary-credential", x: 3n, y: 4n }) });
    release!(completion);
    const [publicResult, duplicate] = await Promise.all([first, second]);

    expect(duplicate).toBe(publicResult);
    expect(publicResult).toMatchObject({ ...result, credentialRebind: { required: false, primary: "ready", secondary: "ready" } });
    expect("verifiedProvisioning" in publicResult).toBe(false);
    const repeated = await handlers.autoProvisionVault({});
    expect(repeated).toEqual(publicResult);
    expect("verifiedProvisioning" in repeated).toBe(false);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(handlers.vaultRecord()?.safe).toBe(SAFE);
    expect(handlers.vaultRecord()?.verifiedProvisioning).toBe(verified);
  });

  it("binds preparation to server-held Safe state and exposes receipt state only", async () => {
    const prepare = vi.fn(async ({ request }: Parameters<NonNullable<Parameters<typeof createBackendHandlers>[0]["prepareTransfer"]>>[0]): Promise<BackendPreparedSubmission> => ({ id: String(request.idempotencyKey), requestHash: HASH, safeTxHash: HASH, kind: "base-transfer", requiredApprovals: ["primary"], publicRequest: request }));
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { provision: vi.fn().mockResolvedValue(completion) }, prepareTransfer: prepare, submission: async () => ({ state: "confirmed", transactionHash: HASH }) });
    handlers.storeCredential(credential("primary", "p", 1));
    handlers.storeCredential(credential("secondary", "s", 3));
    await handlers.autoProvisionVault({});

    await expect(handlers.prepareTransfer({ kind: "transfer", recipient: SAFE, amount: 1n, idempotencyKey: "request-1", safe: FORGED_USDC })).rejects.toThrow(/field/i);
    const request = await handlers.prepareTransfer({ kind: "transfer", recipient: SAFE, amount: 1n, idempotencyKey: "request-1" });
    expect(request.id).toBe("request-1");
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ vault: expect.objectContaining(result), request: { kind: "transfer", recipient: SAFE, amount: 1n, idempotencyKey: "request-1" } }));
    await expect(handlers.submission("request-1")).resolves.toEqual({ state: "confirmed", transactionHash: HASH });
  });

  it("rejects credential reuse and advances a role counter only after verified approval", async () => {
    const verifyAssertion = vi.fn(async (input): Promise<VerifiedPasskeyApproval> => {
      if (verifyAssertion.mock.calls.length === 2) throw new Error("assertion rejected");
      return { role: input.role, credentialId: input.credentialId, counter: input.credential.counter + 1, payload: "0x1234" };
    });
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { provision: vi.fn().mockResolvedValue(completion) }, verifyAssertion });
    const primary = credential("primary", "p", 1);
    handlers.storeCredential(primary);
    expect(() => handlers.storeCredential(primary)).toThrow(/already registered/i);
    expect(() => handlers.storeCredential(credential("secondary", "s", 1))).toThrow(/distinct/i);
    handlers.storeCredential(credential("secondary", "s", 3));
    await handlers.autoProvisionVault({});

    const body = { role: "primary", assertion: { id: "p" } };
    await expect(handlers.verifyApproval(HASH, body)).resolves.toMatchObject({ role: "primary", counter: 1 });
    await expect(handlers.verifyApproval(HASH, body)).rejects.toThrow(/rejected/);
    await expect(handlers.verifyApproval(HASH, body)).resolves.toMatchObject({ role: "primary", counter: 2 });
    expect(verifyAssertion.mock.calls.map(([input]) => input.credential.counter)).toEqual([0, 1, 1]);
  });

  it("makes automatic provisioning unavailable outside the local profile", async () => {
    const provision = vi.fn().mockResolvedValue(completion);
    const handlers = createBackendHandlers({ config: { ...config, id: "https", origin: "https://vault.example", rpId: "vault.example" }, usdc: USDC, provisioner: { provision } });
    handlers.storeCredential(credential("primary", "p", 1));
    handlers.storeCredential(credential("secondary", "s", 3));
    await expect(handlers.autoProvisionVault({})).rejects.toThrow(/local/i);
    expect(provision).not.toHaveBeenCalled();
  });

  it("returns recovery rebind status and gates prepare, approval, submit, and reconcile until both roles are rebound", async () => {
    const prepare = vi.fn(async ({ request }: Parameters<NonNullable<Parameters<typeof createBackendHandlers>[0]["prepareTransfer"]>>[0]): Promise<BackendPreparedSubmission> => ({ id: String(request.idempotencyKey), requestHash: HASH, safeTxHash: HASH, kind: "base-transfer", requiredApprovals: ["primary"], publicRequest: request }));
    const submit = vi.fn(async () => ({ state: "confirmed" }));
    const submission = vi.fn(async () => ({ state: "confirmed" }));
    const provisioner = {
      recoveryCredentials: { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } },
      provision: vi.fn().mockResolvedValue(completion),
    } satisfies AutomaticPwaProvisioner;
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner, prepareTransfer: prepare, submit, submission });
    const recovered = await handlers.autoProvisionVault({});
    expect(handlers.getReadiness?.()).toEqual({ provisioningReady: true, writesReady: false });
    expect(recovered.credentialRebind).toEqual({ required: true, primary: "required", secondary: "required" });
    expect(provisioner.provision).toHaveBeenCalledWith(undefined);

    const request = { kind: "transfer", recipient: SAFE, amount: 1n, idempotencyKey: "recovered-1" };
    await expect(handlers.prepareTransfer(request)).rejects.toThrow(/both recovered passkeys/i);
    await expect(handlers.verifyApproval(HASH, { role: "primary", assertion: { id: "p" } })).rejects.toThrow(/both recovered passkeys/i);
    await expect(handlers.submit("recovered-1", {})).rejects.toThrow(/both recovered passkeys/i);
    await expect(handlers.submission("recovered-1")).rejects.toThrow(/both recovered passkeys/i);

    expect(handlers.rebindCoordinates("primary")).toEqual({ x: 1n, y: 2n });
    expect(handlers.storeReboundCredential(credential("primary", "p", 1))).toEqual({ required: true, primary: "ready", secondary: "required" });
    expect(handlers.getReadiness?.().writesReady).toBe(false);
    await expect(handlers.prepareTransfer(request)).rejects.toThrow(/both recovered passkeys/i);
    expect(handlers.rebindCoordinates("secondary")).toEqual({ x: 3n, y: 4n });
    expect(handlers.storeReboundCredential(credential("secondary", "s", 3))).toEqual({ required: false, primary: "ready", secondary: "ready" });
    expect(handlers.getReadiness?.().writesReady).toBe(true);
    await expect(handlers.prepareTransfer(request)).resolves.toMatchObject({ id: "recovered-1" });
  });

  it("rejects fresh credentials for recovered roles before they can claim sending readiness", async () => {
    const handlers = createBackendHandlers({ config, usdc: USDC, provisioner: { recoveryCredentials: { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } }, provision: vi.fn().mockResolvedValue(completion) }, prepareTransfer: vi.fn(), submit: vi.fn(), submission: vi.fn() });
    await handlers.autoProvisionVault({});
    expect(() => handlers.storeCredential(credential("primary", "wrong-p", 7))).toThrow(/recovered role key/i);
    expect(() => handlers.storeCredential(credential("secondary", "wrong-s", 9))).toThrow(/recovered role key/i);
    expect(handlers.credentialRebindStatus()).toEqual({ required: true, primary: "required", secondary: "required" });
    expect(handlers.getReadiness?.().writesReady).toBe(false);
    handlers.storeReboundCredential(credential("primary", "p", 1));
    handlers.storeReboundCredential(credential("secondary", "s", 3));
    expect(handlers.getReadiness?.().writesReady).toBe(true);
  });
});
