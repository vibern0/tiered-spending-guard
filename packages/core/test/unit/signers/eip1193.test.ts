import { expect } from "chai";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, type Address, type Hex } from "viem";
import { createBurnerSigner, createBurnerWalletConnectSigner, createEip1193SecondarySigner } from "../../../../sdk/src/signers/eip1193";
import * as eip1193 from "../../../../sdk/src/signers/eip1193";
import { assertVaultSignerPair, type Eip1193Provider, type SafeSignerRequest, type VaultSigner } from "../../../../sdk/src/signers/types";

const account = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const OTHER = "0x00000000000000000000000000000000000000b2" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const types = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] as const };
const request: SafeSignerRequest = {
  chainId: 31337, safe: OTHER, safeTxHash: hashTypedData({ domain: { chainId: 31337, verifyingContract: OTHER }, types, primaryType: "SafeTx", message: { to: OTHER, value: 1n, data: "0x" as Hex, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: 0n } }),
  typedData: { domain: { chainId: 31337, verifyingContract: OTHER }, types, primaryType: "SafeTx", message: { to: OTHER, value: 1n, data: "0x" as Hex, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: 0n } },
};

function provider(overrides: Record<string, unknown> = {}): Eip1193Provider {
  return { request: async ({ method, params }) => {
    if (method === "eth_chainId") return overrides[method] ?? "0x7a69";
    if (method === "eth_accounts") return overrides[method] ?? [account.address];
    if (method === "eth_signTypedData_v4") return overrides[method] ?? account.signTypedData(JSON.parse(String((params as unknown[])[1])));
    return overrides[method];
  }};
}

describe("EIP-1193 SafeSigner", () => {
  it("does not expose a raw role-neutral EIP-1193 signer factory", () => {
    expect("createEip1193Signer" in eip1193).to.equal(false);
  });

  it("verifies the local account and exact recovered typed-data address through the EIP-1193 secondary adapter", async () => {
    const signer = createEip1193SecondarySigner({ provider: provider(), account: account.address });
    const extension = await signer.sign(request);
    expect(extension).to.match(/^0x[0-9a-f]+$/);
    expect(extension.endsWith(signer.typeHash.slice(2))).to.equal(true);
  });

  it("exposes an EIP-1193 signer as a secondary ECDSA-extension VaultSigner", async () => {
    const signer = createEip1193SecondarySigner({ provider: provider(), account: account.address });
    expect(signer).to.include({ address: account.address, role: "secondary", kind: "ecdsa-extension" });
    const extension = await signer.sign(request);
    expect(extension.endsWith(signer.typeHash.slice(2))).to.equal(true);
  });

  it("keeps Burner-named factories as compatibility aliases", async () => {
    const signer = createBurnerSigner({ provider: provider(), account: account.address });
    const walletConnectSigner = createBurnerWalletConnectSigner({ provider: provider(), account: account.address });
    expect(signer).to.include({ address: account.address, role: "secondary", kind: "ecdsa-extension" });
    expect(walletConnectSigner).to.include({ address: account.address, role: "secondary", kind: "ecdsa-extension" });
    expect(await signer.sign(request)).to.match(/^0x[0-9a-f]+$/);
  });

  it("fails closed when signer roles or kinds do not match primary-plus-secondary composition", () => {
    const primary = { address: OTHER, role: "primary", kind: "safe-contract", sign: async () => "0x" as Hex } satisfies VaultSigner;
    const secondary = { address: account.address, role: "secondary", kind: "ecdsa-extension", sign: async () => "0x" as Hex } satisfies VaultSigner;
    const safeContractSecondary = { ...secondary, kind: "safe-contract" } satisfies VaultSigner;
    expect(() => assertVaultSignerPair(primary, secondary)).not.to.throw();
    expect(() => assertVaultSignerPair(primary, safeContractSecondary)).not.to.throw();
    expect(() => assertVaultSignerPair({ ...primary, role: "secondary" }, secondary)).to.throw("primary");
    expect(() => assertVaultSignerPair(primary, { ...secondary, role: "primary" })).to.throw("secondary");
    expect(() => assertVaultSignerPair({ ...primary, kind: "ecdsa-extension" }, secondary)).to.throw("safe-contract");
    expect(() => assertVaultSignerPair(primary, { ...secondary, kind: "unknown" as never })).to.throw("kind");
  });

  it("returns the exact ECDSA secondary extension and rejects duplicate append attempts", async () => {
    const signer = createEip1193SecondarySigner({ provider: provider(), account: account.address });
    const extension = await signer.sign(request);
    expect(extension.endsWith(signer.typeHash.slice(2))).to.equal(true);
    expect(extension.slice(2, 132)).to.have.length(130);
    await expect(signer.sign(request)).to.be.rejectedWith("duplicate");
  });

  it("rejects wrong account, provider changes, user rejection, and extension ambiguity", async () => {
    const wrong = privateKeyToAccount("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    await expect(createEip1193SecondarySigner({ provider: provider(), account: wrong.address }).sign(request)).to.be.rejectedWith("account");
    await expect(createEip1193SecondarySigner({ provider: provider({ eth_accounts: [wrong.address] }), account: account.address }).sign(request)).to.be.rejectedWith("account");
    await expect(createEip1193SecondarySigner({ provider: provider({ eth_signTypedData_v4: Promise.reject(new Error("User rejected")) }), account: account.address }).sign(request)).to.be.rejectedWith("rejected");
    await expect(createEip1193SecondarySigner({ provider: { ...provider(), providers: [provider(), provider()] }, account: account.address }).sign(request)).to.be.rejectedWith("ambiguous");
  });

  it("does not expose a recovery signer factory", () => {
    expect(`create${"Recovery"}Signer` in eip1193).to.equal(false);
  });
});
