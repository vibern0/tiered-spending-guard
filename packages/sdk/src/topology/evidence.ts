import { encodeAbiParameters, isAddress, keccak256, type Address, type Hex } from "viem";

export type VerifiedComponent = Readonly<{
  name: "passkeySigner" | "setupHelper" | "guard" | "delay" | "maintenance";
  address: Address;
  runtimeCodeHash: Hex;
  bindingHash: Hex;
  source: string;
}>;

export type ComponentEvidenceClient = {
  getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};

export type PasskeySignerEvidenceInput = Readonly<{
  address: Address;
  runtimeCodeHash: Hex;
  bindingHash: Hex;
  source: string;
  binding: Readonly<{ x: bigint; y: bigint; verifiers: bigint }>;
  factory: Address;
}>;

const SIGNER_FACTORY_ABI = [
  {
    type: "function",
    name: "getSigner",
    stateMutability: "view",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "verifiers", type: "uint176" },
    ],
    outputs: [{ name: "signer", type: "address" }],
  },
] as const;

const assertHash = (value: Hex, label: string): void => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a 32-byte hash`);
};

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function passkeySignerBindingHash(input: { factory: Address; x: bigint; y: bigint; verifiers: bigint }): Hex {
  if (!isAddress(input.factory)) throw new Error("passkey signer factory must be a valid address");
  if (input.x < 0n || input.y < 0n || input.verifiers < 0n || input.verifiers >= (1n << 176n)) {
    throw new Error("passkey signer binding values are out of range");
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
      [input.factory, input.x, input.y, input.verifiers],
    ),
  );
}

export async function verifyPasskeySignerComponent(
  client: ComponentEvidenceClient,
  input: PasskeySignerEvidenceInput,
): Promise<VerifiedComponent> {
  if (!isAddress(input.address)) throw new Error("passkey signer address must be valid");
  assertHash(input.runtimeCodeHash, "passkey signer runtime code hash");
  assertHash(input.bindingHash, "passkey signer binding hash");

  const runtimeCode = await client.getBytecode({ address: input.address });
  if (!runtimeCode || runtimeCode === "0x") throw new Error(`passkeySigner at ${input.address} has no runtime bytecode`);
  const actualRuntimeHash = keccak256(runtimeCode);
  if (!same(actualRuntimeHash, input.runtimeCodeHash)) throw new Error("passkeySigner runtime code hash mismatch");

  const expectedBindingHash = passkeySignerBindingHash({ factory: input.factory, ...input.binding });
  if (!same(expectedBindingHash, input.bindingHash)) throw new Error("passkey signer binding hash mismatch");

  const boundSigner = await client.readContract({
    address: input.factory,
    abi: SIGNER_FACTORY_ABI,
    functionName: "getSigner",
    args: [input.binding.x, input.binding.y, input.binding.verifiers],
  });
  if (typeof boundSigner !== "string" || !isAddress(boundSigner) || !same(boundSigner, input.address)) {
    throw new Error("passkey signer binding mismatch");
  }

  return Object.freeze({
    name: "passkeySigner",
    address: input.address,
    runtimeCodeHash: input.runtimeCodeHash,
    bindingHash: input.bindingHash,
    source: input.source,
  });
}
