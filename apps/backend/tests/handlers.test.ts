import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createBackendHandlers } from "../src/handlers";
import type { BackendConfig } from "../src/config";
import type { ReviewedDeploymentEvidence, SafeExecutionRequest } from "../src/vault";
import type { VerifiedPasskeyApproval } from "../src/webauthn";

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
  rpcUrl: "https://sepolia.example.invalid", relayPrivateKey: `0x${"11".repeat(32)}`, journalPath: "/tmp/backend-journal.json", reviewedArtifactsPath: "/tmp/reviewed.json",
  provisionerModulePath: "/tmp/provisioner.mjs",
} satisfies BackendConfig;
const artifacts = { verified: true, chainId: 11155111, safeSingleton: SAFE, safeProxyFactory: GUARD, passkeySignerFactory: PRIMARY, delayArtifactHash: HASH } satisfies ReviewedDeploymentEvidence;
const result = { chainId: 11155111, safe: SAFE, guard: GUARD, delay: DELAY, primaryPasskey: PRIMARY, secondaryPasskey: SECONDARY, usdc: USDC, evidence: { setupTransactionHash: HASH, verificationReportHash: HASH } } as const;
const publicKey = (fill: number) => Uint8Array.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...new Uint8Array(32).fill(fill), 0x22, 0x58, 0x20, ...new Uint8Array(32).fill(fill + 1)]);
const credential = (role: "primary" | "secondary", id: string, fill: number, counter = 0) => ({ role, id, credentialId: id, publicKey: publicKey(fill), counter, x: BigInt(fill), y: BigInt(fill + 1) });

describe("server-authoritative backend handlers", () => {
  it("ignores browser deployment fields and binds provisioning to verified credentials", async () => {
    const deploy = vi.fn().mockResolvedValue(result);
    const handlers = createBackendHandlers({ config, artifacts, usdc: USDC, provisioner: { deploy } });
    handlers.storeCredential(credential("primary", "primary-credential", 1));
    handlers.storeCredential(credential("secondary", "secondary-credential", 3));

    await handlers.provisionVault({ chainId: 11155111, usdc: FORGED_USDC, primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential", safe: "0x9999999999999999999999999999999999999999", setupTransactionHash: "forged" });

    expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111, usdc: USDC, primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential", artifacts }));
    expect(deploy.mock.calls[0]?.[0]).not.toHaveProperty("safe");
    expect(handlers.vaultRecord()?.safe).toBe(SAFE);
  });

  it("binds preparation to server-held Safe state and exposes receipt state only", async () => {
    const prepare = vi.fn(async ({ vault }: { vault: typeof result; request: { recipient: unknown; amount: unknown; idempotencyKey: unknown } }): Promise<SafeExecutionRequest> => ({
      version: 1, kind: "safe-execution", idempotencyKey: HASH, chainId: 11155111, deploymentsHash: HASH, policyHash: HASH, safe: vault.safe, guard: vault.guard, asset: vault.usdc,
      transaction: { to: vault.usdc, value: 0n, data: "0x1234", operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: 4n }, safeTxHash: HASH, expectedSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
    }));
    const handlers = createBackendHandlers({ config, artifacts, usdc: USDC, provisioner: { deploy: vi.fn().mockResolvedValue(result) }, prepareTransfer: prepare, submission: () => ({ state: "confirmed", transactionHash: HASH }) });
    handlers.storeCredential(credential("primary", "p", 1));
    handlers.storeCredential(credential("secondary", "s", 3));
    await handlers.provisionVault({ chainId: 11155111, usdc: USDC, primaryCredentialId: "p", secondaryCredentialId: "s" });

    const request = await handlers.prepareTransfer({ safe: "0x9999999999999999999999999999999999999999", usdc: "0x9999999999999999999999999999999999999999", recipient: SAFE, amount: 1n, nonce: 999n });
    expect(request.safe).toBe(SAFE);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ vault: expect.objectContaining(result), request: { recipient: SAFE, amount: 1n, idempotencyKey: undefined } }));
    expect(handlers.submission("request-1")).toEqual({ state: "confirmed", transactionHash: HASH });
  });

  it("rejects credential reuse and advances a role counter only after verified approval", async () => {
    const verifyAssertion = vi.fn(async (input): Promise<VerifiedPasskeyApproval> => {
      if (verifyAssertion.mock.calls.length === 2) throw new Error("assertion rejected");
      return { role: input.role, credentialId: input.credentialId, counter: input.credential.counter + 1, payload: "0x1234" };
    });
    const handlers = createBackendHandlers({ config, artifacts, usdc: USDC, provisioner: { deploy: vi.fn().mockResolvedValue(result) }, verifyAssertion });
    const primary = credential("primary", "p", 1);
    handlers.storeCredential(primary);
    expect(() => handlers.storeCredential(primary)).toThrow(/already registered/i);
    expect(() => handlers.storeCredential(credential("secondary", "s", 1))).toThrow(/distinct/i);
    handlers.storeCredential(credential("secondary", "s", 3));
    await handlers.provisionVault({ chainId: 11155111, usdc: USDC, primaryCredentialId: "p", secondaryCredentialId: "s" });

    const body = { role: "primary", assertion: { id: "p" } };
    await expect(handlers.verifyApproval(HASH, body)).resolves.toMatchObject({ role: "primary", counter: 1 });
    await expect(handlers.verifyApproval(HASH, body)).rejects.toThrow(/rejected/);
    await expect(handlers.verifyApproval(HASH, body)).resolves.toMatchObject({ role: "primary", counter: 2 });
    expect(verifyAssertion.mock.calls.map(([input]) => input.credential.counter)).toEqual([0, 1, 1]);
  });
});
