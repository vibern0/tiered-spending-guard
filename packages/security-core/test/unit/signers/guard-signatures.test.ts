import { expect } from "chai";
import { hashTypedData, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeSafeContractSignature } from "../../../src/signers/passkey-helpers";
import { encodeGuardSafeSignatures } from "../../../src/signers/guard-signatures";
import { createEip1193SecondarySigner } from "../../../src/signers/eip1193";
import type { SafeSignerRequest, VaultSigner } from "../../../src/signers/types";

const PRIMARY = "0x9000000000000000000000000000000000000001" as Address;
const LOWER_SECONDARY = "0x1000000000000000000000000000000000000002" as Address;
const SAFE = "0x2000000000000000000000000000000000000003" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const TYPES = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] as const };
const MESSAGE = { to: SAFE, value: 1n, data: "0x" as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: 0n };
const REQUEST: SafeSignerRequest = { chainId: 31337, safe: SAFE, safeTxHash: hashTypedData({ domain: { chainId: 31337, verifyingContract: SAFE }, types: TYPES, primaryType: "SafeTx", message: MESSAGE }), typedData: { domain: { chainId: 31337, verifyingContract: SAFE }, types: TYPES, primaryType: "SafeTx", message: MESSAGE } };

const signer = (address: Address, role: "primary" | "secondary", payload: Hex): VaultSigner => ({ address, role, kind: "safe-contract", sign: async () => encodeSafeContractSignature(address, payload) });
const word = (value: bigint) => toHex(value, { size: 32 }).slice(2);

describe("guard Safe signature encoder", () => {
  it("keeps the primary-only canonical contract signature", async () => {
    expect(await encodeGuardSafeSignatures(REQUEST, signer(PRIMARY, "primary", "0x1234"))).to.equal(encodeSafeContractSignature(PRIMARY, "0x1234"));
  });

  it("places primary first even when the secondary address sorts lower", async () => {
    const actual = await encodeGuardSafeSignatures(REQUEST, signer(PRIMARY, "primary", "0x1234"), signer(LOWER_SECONDARY, "secondary", "0xaabbcc"));
    const primarySlot = `${PRIMARY.slice(2).padStart(64, "0")}${word(130n)}00`;
    const secondaryOffset = 130n + 32n + 2n;
    const secondarySlot = `${LOWER_SECONDARY.slice(2).padStart(64, "0")}${word(secondaryOffset)}00`;
    expect(actual).to.equal(`0x${primarySlot}${secondarySlot}${word(2n)}1234${word(3n)}aabbcc`);
  });

  it("rejects swapped, duplicate, trailing, and gapped signer output", async () => {
    const primary = signer(PRIMARY, "primary", "0x12");
    const secondary = signer(LOWER_SECONDARY, "secondary", "0x34");
    await expect(encodeGuardSafeSignatures(REQUEST, { ...primary, role: "secondary" }, secondary)).to.be.rejectedWith("primary");
    await expect(encodeGuardSafeSignatures(REQUEST, primary, { ...secondary, address: PRIMARY })).to.be.rejectedWith("distinct");
    await expect(encodeGuardSafeSignatures(REQUEST, { ...primary, sign: async () => `${encodeSafeContractSignature(PRIMARY, "0x12")}00` as Hex }, secondary)).to.be.rejectedWith("canonical");
    const gapped = `0x${PRIMARY.slice(2).padStart(64, "0")}${word(66n)}00${word(1n)}12` as Hex;
    await expect(encodeGuardSafeSignatures(REQUEST, { ...primary, sign: async () => gapped }, secondary)).to.be.rejectedWith("canonical");
  });

  it("appends the exact ECDSA extension terminally", async () => {
    const account = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
    const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_signTypedData_v4") return account.signTypedData(JSON.parse(String(params?.[1])));
      throw new Error("unexpected method");
    } };
    const secondary = createEip1193SecondarySigner({ account: account.address, provider });
    const primary = signer(PRIMARY, "primary", "0x1234");
    const encoded = await encodeGuardSafeSignatures(REQUEST, primary, secondary);
    expect(encoded.startsWith(encodeSafeContractSignature(PRIMARY, "0x1234"))).to.equal(true);
    expect(encoded.endsWith(secondary.typeHash.slice(2))).to.equal(true);
    expect(encoded.slice(-128, -64)).to.equal(word(65n));
  });
});
