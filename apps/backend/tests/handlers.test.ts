import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createBackendHandlers } from "../src/handlers";
import type { BackendConfig } from "../src/config";
import type { ReviewedDeploymentEvidence, SafeExecutionRequest } from "../src/vault";

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

describe("server-authoritative backend handlers", () => {
  it("ignores browser deployment fields and binds provisioning to verified credentials", async () => {
    const deploy = vi.fn().mockResolvedValue(result);
    const handlers = createBackendHandlers({ config, artifacts, usdc: USDC, provisioner: { deploy } });
    handlers.storeCredential({ role: "primary", id: "primary-credential", credentialId: "primary-credential", publicKey: "primary-key", counter: 0 });
    handlers.storeCredential({ role: "secondary", id: "secondary-credential", credentialId: "secondary-credential", publicKey: "secondary-key", counter: 0 });

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
    handlers.storeCredential({ role: "primary", id: "p", credentialId: "p", publicKey: "p", counter: 0 });
    handlers.storeCredential({ role: "secondary", id: "s", credentialId: "s", publicKey: "s", counter: 0 });
    await handlers.provisionVault({ chainId: 11155111, usdc: USDC, primaryCredentialId: "p", secondaryCredentialId: "s" });

    const request = await handlers.prepareTransfer({ safe: "0x9999999999999999999999999999999999999999", usdc: "0x9999999999999999999999999999999999999999", recipient: SAFE, amount: 1n, nonce: 999n });
    expect(request.safe).toBe(SAFE);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ vault: expect.objectContaining(result), request: { recipient: SAFE, amount: 1n, idempotencyKey: undefined } }));
    expect(handlers.submission("request-1")).toEqual({ state: "confirmed", transactionHash: HASH });
  });
});
