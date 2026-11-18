import { encodeFunctionData, type Address, type Hex } from "viem";
import { snapshotSafeSignerRequest, type Eip1193Provider, type SafeSignerRequest, type SignerRole, type VaultSigner } from "./types";
import { ERC1271_ABI, encodeSafeContractSignature } from "./passkey-helpers";

export type PasskeyCoreOptions = Readonly<{
  address: Address;
  verifierAddress: Address;
  chainId: number;
  role?: SignerRole;
  provider: Eip1193Provider;
  sign(request: SafeSignerRequest): Promise<Hex>;
}>;

async function assertProviderChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const value = await provider.request({ method: "eth_chainId" });
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || Number(BigInt(value)) !== chainId) throw new Error("provider chain changed");
}

async function signPasskeyRequest(options: PasskeyCoreOptions, input: SafeSignerRequest): Promise<Hex> {
  const request = snapshotSafeSignerRequest(input);
  if (options.chainId !== request.chainId) throw new Error("deployment chain does not match request chain");
  await assertProviderChain(options.provider, request.chainId);
  const rawSignature = await options.sign(request);
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(rawSignature)) throw new Error("invalid passkey signature encoding");
  const result = await options.provider.request({ method: "eth_call", params: [{ to: options.verifierAddress, data: encodeFunctionData({ abi: ERC1271_ABI, functionName: "isValidSignature", args: [request.safeTxHash, rawSignature] }) }, "latest"] });
  await assertProviderChain(options.provider, request.chainId);
  if (typeof result !== "string" || (result.length !== 10 && result.length !== 66) || !/^0x[0-9a-f]{8}$/i.test(result.slice(0, 10)) || result.slice(0, 10).toLowerCase() !== "0x1626ba7e") throw new Error("invalid ERC-1271 passkey signature");
  return encodeSafeContractSignature(options.address, rawSignature);
}

/** Internal shared implementation for production and test passkey adapters. */
export function createPasskeySignerCore(options: PasskeyCoreOptions): VaultSigner {
  const role = options.role ?? "primary";
  if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey signer role");
  return Object.freeze({
    address: options.address,
    role,
    kind: "safe-contract",
    sign: (input) => signPasskeyRequest(options, input),
  });
}
