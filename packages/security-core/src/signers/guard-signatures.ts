import { isAddress, toHex, type Address, type Hex } from "viem";
import { assertSameSignerRequest, assertVaultSignerPair, snapshotSafeSignerRequest, type SafeSignerRequest, type VaultSigner } from "./types";

const hexBytes = (value: Hex): Uint8Array => Uint8Array.from(Buffer.from(value.slice(2), "hex"));
const hexSlice = (value: Uint8Array, start: number, end: number): Hex => `0x${Buffer.from(value.slice(start, end)).toString("hex")}` as Hex;
const uint = (value: Uint8Array, start: number): bigint => BigInt(hexSlice(value, start, start + 32));

function contractPayload(signature: Hex, expected: VaultSigner): Hex {
  const value = hexBytes(signature);
  if (value.length < 97 || value[64] !== 0) throw new Error("guard signer did not return a canonical Safe contract signature");
  const signer = hexSlice(value, 12, 32);
  const offset = uint(value, 32);
  const length = uint(value, 65);
  if (signer.toLowerCase() !== expected.address.toLowerCase() || offset !== 65n || length <= 0n || length > BigInt(Number.MAX_SAFE_INTEGER) || value.length !== 97 + Number(length)) throw new Error("guard signer did not return a canonical Safe contract signature");
  return hexSlice(value, 97, value.length);
}

const slot = (address: string, offset: bigint): string => `${address.slice(2).padStart(64, "0")}${toHex(offset, { size: 32 }).slice(2)}00`;
const tail = (payload: Hex): string => `${toHex(BigInt((payload.length - 2) / 2), { size: 32 }).slice(2)}${payload.slice(2)}`;

export type VerifiedContractApproval = Readonly<{ address: Address; payload: Hex }>;

function assertApproval(value: VerifiedContractApproval, label: string): void {
  if (!isAddress(value.address)) throw new Error(`${label} signer address is invalid`);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(value.payload)) throw new Error(`${label} verified passkey payload is invalid`);
}

/** Encodes already-verified contract-passkey payloads in the guard's primary-first layout. */
export function encodeGuardContractSignatures(primary: VerifiedContractApproval, secondary?: VerifiedContractApproval): Hex {
  assertApproval(primary, "primary");
  if (!secondary) return `0x${slot(primary.address, 65n)}${tail(primary.payload)}`.toLowerCase() as Hex;
  assertApproval(secondary, "secondary");
  if (secondary.address.toLowerCase() === primary.address.toLowerCase()) throw new Error("primary and secondary passkey signers must be distinct");
  const primaryOffset = 130n;
  const secondaryOffset = primaryOffset + 32n + BigInt((primary.payload.length - 2) / 2);
  return `0x${slot(primary.address, primaryOffset)}${slot(secondary.address, secondaryOffset)}${tail(primary.payload)}${tail(secondary.payload)}`.toLowerCase() as Hex;
}

/** Encodes the TieredSpendingGuard's primary-first signature layout. */
export async function encodeGuardSafeSignatures(requestInput: SafeSignerRequest, primary: VaultSigner, secondary?: VaultSigner): Promise<Hex> {
  const request = snapshotSafeSignerRequest(requestInput);
  if (primary.role !== "primary" || primary.kind !== "safe-contract") throw new Error("primary signer role mismatch");
  const signBound = async (signer: VaultSigner): Promise<Hex> => {
    assertSameSignerRequest(request, requestInput);
    const signature = await signer.sign(request);
    assertSameSignerRequest(request, requestInput);
    return signature;
  };
  if (!secondary) {
    const signature = await signBound(primary);
    return encodeGuardContractSignatures({ address: primary.address, payload: contractPayload(signature, primary) });
  }
  assertVaultSignerPair(primary, secondary);
  const primaryPayload = contractPayload(await signBound(primary), primary);
  if (secondary.kind === "ecdsa-extension") {
    const extension = await signBound(secondary);
    if (!/^0x[0-9a-f]{258}$/i.test(extension)) throw new Error("guard ECDSA secondary extension is not canonical");
    return `0x${slot(primary.address, 65n)}${tail(primaryPayload)}${extension.slice(2)}` as Hex;
  }
  const secondaryPayload = contractPayload(await signBound(secondary), secondary);
  return encodeGuardContractSignatures({ address: primary.address, payload: primaryPayload }, { address: secondary.address, payload: secondaryPayload });
}
