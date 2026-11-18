import { toHex, type Address, type Hex } from "viem";

export const ERC1271_ABI = [{ name: "isValidSignature", type: "function", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ type: "bytes4" }] }] as const;

export function encodeSafeContractSignature(address: Address, rawSignature: Hex): Hex {
  const byteLength = (rawSignature.length - 2) / 2;
  return `0x${address.slice(2).padStart(64, "0")}${toHex(65n, { size: 32 }).slice(2)}00${toHex(BigInt(byteLength), { size: 32 }).slice(2)}${rawSignature.slice(2)}` as Hex;
}
