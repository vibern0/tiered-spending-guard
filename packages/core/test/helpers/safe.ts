import { toHex, type Address, type Hex } from "viem";
import { SAFE_TX_TYPES } from "../../../sdk/src/signers/types";

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const ECDSA_SECONDARY_SIGNATURE_TYPE_HASH = "0xc3d042548a46ef9078620b2d3fe7e21f006a7ecf29ab9b2807d4bdbbc41cecf0" as Hex;

export const safeTxTypes = { SafeTx: SAFE_TX_TYPES } as const;

export function fn(name: string, inputs: readonly object[], outputs: readonly object[] = []): readonly object[] {
  return [{ name, type: "function", stateMutability: "nonpayable", inputs, outputs }] as const;
}

export const transferAbi = fn("transfer", [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }]);
export const queueAbi = fn("execTransactionFromModule", [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }]);

type SafeFixtureHre = Readonly<{
  viem: Readonly<{
    deployContract(name: string, args?: readonly unknown[]): Promise<any>;
    getContractAt(name: string, address: Address): Promise<any>;
  }>;
}>;

type SafeFixtureDeployer = Readonly<{ account: Readonly<{ address: Address }> }>;

export async function deploySafeFixture(hre: SafeFixtureHre, deployer: SafeFixtureDeployer, ownerAddresses: readonly Address[]) {
  const singleton = await hre.viem.deployContract("Safe");
  const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
  const safe = await hre.viem.getContractAt("Safe", proxy.address);
  const owners = [...ownerAddresses].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  await safe.write.setup([owners, 1n, ZERO, "0x", ZERO, ZERO, 0n, ZERO], { account: deployer.account });
  return { singleton, proxy, safe, owners };
}

type SafeNonceReader = Readonly<{
  address: Address;
  read: Readonly<{ nonce: () => Promise<bigint> }>;
}>;

type TypedDataSigner = Readonly<{
  signTypedData(args: any): Promise<Hex>;
}>;

export async function signSafeTransaction(
  safe: SafeNonceReader,
  signer: TypedDataSigner,
  to: Address,
  data: Hex,
  options: Readonly<{ chainId?: number; value?: bigint; operation?: 0 | 1; nonce?: bigint }> = {},
): Promise<Hex> {
  const value = options.value ?? 0n;
  const operation = options.operation ?? 0;
  const nonce = options.nonce ?? await safe.read.nonce();
  return signer.signTypedData({
    domain: { chainId: options.chainId ?? 31337, verifyingContract: safe.address },
    types: safeTxTypes,
    primaryType: "SafeTx",
    message: { to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce },
  });
}

export function passkeySignature(address: Address): Hex {
  return `0x${address.slice(2).padStart(64, "0")}${toHex(65n, { size: 32 }).slice(2)}00${toHex(0n, { size: 32 }).slice(2)}` as Hex;
}

export function safeContractSignatures(primary: Address, secondary: Address, primaryPayload: Hex = "0x", secondaryPayload: Hex = "0x"): Hex {
  const primaryPayloadOffset = 65n * 2n;
  const primaryPayloadLength = BigInt((primaryPayload.length - 2) / 2);
  const secondaryPayloadLength = BigInt((secondaryPayload.length - 2) / 2);
  const secondaryPayloadOffset = primaryPayloadOffset + 32n + primaryPayloadLength;
  return `0x${
    primary.slice(2).padStart(64, "0")
  }${
    toHex(primaryPayloadOffset, { size: 32 }).slice(2)
  }00${
    secondary.slice(2).padStart(64, "0")
  }${
    toHex(secondaryPayloadOffset, { size: 32 }).slice(2)
  }00${
    toHex(primaryPayloadLength, { size: 32 }).slice(2)
  }${
    primaryPayload.slice(2)
  }${
    toHex(secondaryPayloadLength, { size: 32 }).slice(2)
  }${
    secondaryPayload.slice(2)
  }` as Hex;
}

export function ecdsaSecondaryEnvelope(passkey: Address, ecdsaSecondarySignature: Hex): Hex {
  return `${passkeySignature(passkey)}${ecdsaSecondarySignature.slice(2)}${toHex((ecdsaSecondarySignature.length - 2) / 2, { size: 32 }).slice(2)}${ECDSA_SECONDARY_SIGNATURE_TYPE_HASH.slice(2)}` as Hex;
}

/** @deprecated use ecdsaSecondaryEnvelope. */
export const burnerEnvelope = ecdsaSecondaryEnvelope;
