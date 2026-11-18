import type { Address, Hex } from "viem";
import { isVerifiedDeploymentInfrastructure, type VerifiedDeploymentInfrastructure } from "../config/deployments";
import type { Eip1193Provider, SafeSignerRequest, SignerRole, VaultSigner } from "./types";
import { createPasskeySignerCore } from "./passkey-core";

export type PasskeySignerOptions = Readonly<{
  address: Address;
  role?: SignerRole;
  provider: Eip1193Provider;
  sign(request: SafeSignerRequest): Promise<Hex>;
  deployments: VerifiedDeploymentInfrastructure;
}>;


/** Safe-native passkey adapter. ERC-1271 is queried at the configured signer identity. */
export function createPasskeySigner(options: PasskeySignerOptions): VaultSigner {
  if (!isVerifiedDeploymentInfrastructure(options.deployments)) throw new Error("passkey verifier requires official deployment evidence");
  const signer = options.deployments.passkeySigner;
  if (!signer || !/^0x[0-9a-f]{64}$/i.test(signer.runtimeCodeHash) || !/^0x[0-9a-f]{64}$/i.test(signer.bindingHash) || signer.address.toLowerCase() !== options.address.toLowerCase()) throw new Error("signer must be the verified configured passkey instance");
  return createPasskeySignerCore({ address: options.address, role: options.role, verifierAddress: signer.address, chainId: options.deployments.chainId, provider: options.provider, sign: options.sign });
}
