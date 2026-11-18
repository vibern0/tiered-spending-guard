import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";

export type SafeTxMessage = Readonly<{
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}>;

export type SafeTxTypedData = Readonly<{
  domain: Readonly<{ chainId: number; verifyingContract: Address }>;
  types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>;
  primaryType: "SafeTx";
  message: SafeTxMessage;
}>;

export type SafeSignerRequest = Readonly<{
  chainId: number;
  safe: Address;
  safeTxHash: Hex;
  typedData: SafeTxTypedData;
}>;

export type SignerRole = "primary" | "secondary";
export type SignerKind = "safe-contract" | "ecdsa-extension";

export type SafeSigner = Readonly<{
  address: Address;
  sign(request: SafeSignerRequest): Promise<Hex>;
}>;

export type VaultSigner = Readonly<{
  address: Address;
  role: SignerRole;
  kind: SignerKind;
  sign(request: SafeSignerRequest): Promise<Hex>;
}>;

export type Eip1193Provider = Readonly<{
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  providers?: readonly Eip1193Provider[];
}>;

export const SAFE_TX_TYPES = [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
] as const;

const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function snapshotSafeSignerRequest(input: SafeSignerRequest): SafeSignerRequest {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("invalid chain");
  if (input.typedData.primaryType !== "SafeTx") throw new Error("invalid typed data");
  assertCanonicalSafeTx(input);
  if (input.typedData.domain.chainId !== input.chainId) throw new Error("typed data chain mismatch");
  if (!sameAddress(input.typedData.domain.verifyingContract, input.safe)) throw new Error("typed data Safe mismatch");
  const safeTxHash = hashTypedData(input.typedData as unknown as TypedDataDefinition) as Hex;
  if (safeTxHash.toLowerCase() !== input.safeTxHash.toLowerCase()) throw new Error("Safe transaction hash mismatch");
  const typedData = JSON.parse(JSON.stringify(input.typedData, (_, value: unknown) => typeof value === "bigint" ? `${value}n` : value), (_, value: unknown) => typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as SafeTxTypedData;
  return Object.freeze({ ...input, typedData: Object.freeze(typedData) });
}

const SAFE_TX_FIELD_NAMES = SAFE_TX_TYPES.map(({ name }) => name);

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw new Error(`non-canonical ${label}`);
}

function isAddressValue(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
}

function isHexValue(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);
}

function isUint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

function assertCanonicalSafeTx(input: SafeSignerRequest): void {
  const typedData = input.typedData;
  assertExactKeys(typedData.domain, ["chainId", "verifyingContract"], "SafeTx domain");
  assertExactKeys(typedData.types, ["SafeTx"], "SafeTx types");
  const fields = typedData.types.SafeTx;
  if (!Array.isArray(fields) || fields.length !== SAFE_TX_TYPES.length || fields.some((field, index) => field.name !== SAFE_TX_TYPES[index].name || field.type !== SAFE_TX_TYPES[index].type || Object.keys(field).length !== 2)) throw new Error("non-canonical SafeTx types");
  assertExactKeys(typedData.message, SAFE_TX_FIELD_NAMES, "SafeTx message");
  const message = typedData.message;
  if (!isAddressValue(input.safe) || !isAddressValue(typedData.domain.verifyingContract) || !isAddressValue(message.to) || !isAddressValue(message.gasToken) || !isAddressValue(message.refundReceiver) || !isHexValue(message.data) || ![0, 1].includes(message.operation) || !isUint(message.value) || !isUint(message.safeTxGas) || !isUint(message.baseGas) || !isUint(message.gasPrice) || !isUint(message.nonce)) throw new Error("non-canonical SafeTx message");
}

export function sameSignerRequest(left: SafeSignerRequest, right: SafeSignerRequest): boolean {
  return left.chainId === right.chainId && sameAddress(left.safe, right.safe) && left.safeTxHash.toLowerCase() === right.safeTxHash.toLowerCase() &&
    JSON.stringify(left.typedData, (_, value: unknown) => typeof value === "bigint" ? `${value}n` : value) ===
    JSON.stringify(right.typedData, (_, value: unknown) => typeof value === "bigint" ? `${value}n` : value);
}

export function assertSameSignerRequest(expected: SafeSignerRequest, actual: SafeSignerRequest): void {
  if (!sameSignerRequest(expected, actual)) throw new Error("signer request mutated");
}

export function assertVaultSignerPair(primary: VaultSigner, secondary: VaultSigner): void {
  if (primary.role !== "primary") throw new Error("primary signer role mismatch");
  if (primary.kind !== "safe-contract") throw new Error("primary signer kind must be safe-contract");
  if (secondary.role !== "secondary") throw new Error("secondary signer role mismatch");
  if (secondary.kind !== "safe-contract" && secondary.kind !== "ecdsa-extension") throw new Error("secondary signer kind mismatch");
  if (sameAddress(primary.address, secondary.address)) throw new Error("primary and secondary signers must be distinct");
}
