import type { Hex } from "viem";
import type { SafeSignerRequest, VaultSigner } from "../../../sdk/src/signers/types";
import { createPasskeySignerCore, type PasskeyCoreOptions } from "../../../sdk/src/signers/passkey-core";

type PasskeySignatureOptions = Readonly<Pick<PasskeyCoreOptions, "address" | "verifierAddress" | "chainId" | "provider" | "role"> & {
  sign(request: SafeSignerRequest): Promise<Hex>;
}>;

/*
 * Test-only low-level adapter for exercising mock ERC-1271 verifier behavior.
 * It intentionally bypasses production deployment-evidence checks.
 */
export function createTestPasskeySigner(options: PasskeySignatureOptions): VaultSigner {
  return createPasskeySignerCore(options);
}
