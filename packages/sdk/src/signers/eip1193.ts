import { hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { snapshotSafeSignerRequest, type Eip1193Provider, type SafeSignerRequest, type VaultSigner } from "./types";

// Keep the extension type hash identical to TieredSpendingGuard.ECDSA_SECONDARY_SIGNATURE_TYPE_HASH.
export const ECDSA_SECONDARY_SIGNATURE_TYPE_HASH = keccak256(toHex("TieredSpendingGuard.EcdsaSecondarySignature.v1"));

function providerIsUnambiguous(provider: Eip1193Provider): void {
  if (provider.providers && provider.providers.length !== 1) throw new Error("ambiguous EIP-1193 provider");
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) throw new Error(`invalid ${label}`);
  return value as Address;
}

function asChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("invalid provider chain");
  const chainId = Number(BigInt(value));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("invalid provider chain");
  return chainId;
}

function normalizeSafeEcdsaSignature(signature: Hex): Hex {
  const recovery = Number.parseInt(signature.slice(-2), 16);
  if (recovery === 0 || recovery === 1) return `${signature.slice(0, -2)}${(recovery + 27).toString(16)}` as Hex;
  if (recovery !== 27 && recovery !== 28) throw new Error("invalid ECDSA recovery id");
  return signature;
}

async function providerState(provider: Eip1193Provider, expected: SafeSignerRequest, account: Address): Promise<void> {
  const chainId = asChainId(await provider.request({ method: "eth_chainId" }));
  if (chainId !== expected.chainId) throw new Error("provider chain changed");
  const accounts = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || accounts.length !== 1 || asAddress(accounts[0], "provider account").toLowerCase() !== account.toLowerCase()) throw new Error("provider account changed");
}

export type Eip1193SignerOptions = Readonly<{ provider: Eip1193Provider; account: Address }>;

function createEip1193Signer(options: Eip1193SignerOptions): VaultSigner {
  const seen = new Set<string>();
  return Object.freeze({
    address: options.account,
    role: "secondary",
    kind: "ecdsa-extension",
    sign: async (input) => {
      const request = snapshotSafeSignerRequest(input);
      providerIsUnambiguous(options.provider);
      await providerState(options.provider, request, options.account);
      const key = request.safeTxHash.toLowerCase();
      if (seen.has(key)) throw new Error("duplicate signature request");
      let signature: Hex;
      try {
        signature = await options.provider.request({ method: "eth_signTypedData_v4", params: [options.account, JSON.stringify(request.typedData, (_, value: unknown) => typeof value === "bigint" ? `${value}` : value)] }) as Hex;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/reject|denied|cancel/i.test(message)) throw new Error("user rejected signature");
        throw new Error(`typed-data signature failed: ${message}`);
      }
      if (!/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error("invalid ECDSA signature");
      signature = normalizeSafeEcdsaSignature(signature);
      await providerState(options.provider, request, options.account);
      const recovered = await recoverTypedDataAddress({ ...request.typedData, signature } as never);
      if (recovered.toLowerCase() !== options.account.toLowerCase()) throw new Error("wrong recovered account");
      if (hashTypedData(request.typedData as never).toLowerCase() !== request.safeTxHash.toLowerCase()) throw new Error("typed data hash changed");
      seen.add(key);
      return signature;
    },
  });
}

export type Eip1193SecondarySigner = VaultSigner & Readonly<{ typeHash: Hex }>;

export function createEip1193SecondarySigner(options: Eip1193SignerOptions): Eip1193SecondarySigner {
  const base = createEip1193Signer(options);
  return Object.freeze({ ...base, typeHash: ECDSA_SECONDARY_SIGNATURE_TYPE_HASH, sign: async (request) => {
    const signature = await base.sign(request);
    return `${signature}${toHex(65n, { size: 32 }).slice(2)}${ECDSA_SECONDARY_SIGNATURE_TYPE_HASH.slice(2)}` as Hex;
  }});
}

/** @deprecated use Eip1193SecondarySigner. */
export type BurnerWalletConnectSigner = Eip1193SecondarySigner;
/** @deprecated use createEip1193SecondarySigner. */
export const createBurnerWalletConnectSigner = createEip1193SecondarySigner;
/** @deprecated use createEip1193SecondarySigner. */
export const createBurnerSigner = createEip1193SecondarySigner;
