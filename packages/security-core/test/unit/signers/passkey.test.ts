import { expect } from "chai";
import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import * as passkeyModule from "../../../src/signers/passkey";
import { createPasskeySigner } from "../../../src/signers/passkey";
import { createTestPasskeySigner } from "../../helpers/passkey";
import { brandVerifiedDeploymentInfrastructureForTestsOnly } from "../../../src/config/deployments";
import { SAFE_TX_TYPES, type Eip1193Provider, type SafeSignerRequest } from "../../../src/signers/types";

const PASSKEY = "0x00000000000000000000000000000000000000a1" as Address;
const SAFE = "0x00000000000000000000000000000000000000b2" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const typedData = (chainId: number, safe: Address, nonce = 7n) => ({
  domain: { chainId, verifyingContract: safe },
  types: { SafeTx: SAFE_TX_TYPES },
  primaryType: "SafeTx" as const,
  message: { to: SAFE, value: 1n, data: "0x" as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce },
});

const request = (overrides: Partial<SafeSignerRequest> = {}): SafeSignerRequest => ({
  chainId: 31337,
  safe: SAFE,
  safeTxHash: hashTypedData(typedData(31337, SAFE)),
  typedData: typedData(31337, SAFE),
  ...overrides,
});

function verifierProvider(result = "0x1626ba7e", onCall?: (params: unknown[]) => void, chainId = "0x7a69"): Eip1193Provider {
  return { request: async ({ method, params }) => {
    if (method === "eth_chainId") return chainId;
    if (method === "eth_call") { onCall?.(params ?? []); return result; }
    throw new Error(`unexpected provider method ${method}`);
  }};
}

const testPasskeySigner = (provider = verifierProvider(), sign: (request: SafeSignerRequest) => Promise<Hex> = async () => "0x12") => ({
  ...createTestPasskeySigner({ address: PASSKEY, verifierAddress: PASSKEY, chainId: 31337, provider, sign }),
});

const fabricatedDeployments = (branded = false) => Object.freeze({
  chainId: 31337,
  dependencies: Object.freeze({ passkeySignerVerifier: Object.freeze({ address: PASSKEY }) }),
  ...(branded ? { [Symbol.for("tiered-spending-guard.test.verified-deployments")]: true } : {}),
});

const verifiedDeployments = () => brandVerifiedDeploymentInfrastructureForTestsOnly({
  chainId: 31337,
  passkeySigner: Object.freeze({ name: "passkeySigner", address: PASSKEY, runtimeCodeHash: `0x${"22".repeat(32)}`, bindingHash: `0x${"33".repeat(32)}`, source: "verified factory binding" }),
  passkeySignerVerifier: Object.freeze({
    name: "fixture passkey verifier",
    version: "0.2.0",
    address: SAFE,
    runtimeCodeHash: `0x${"11".repeat(32)}` as Hex,
    evidence: "verified",
    source: "fixture",
  }),
} as never);

describe("passkey SafeSigner", () => {
  it("exports only the evidence-bound production passkey signer factory", () => {
    expect(Object.keys(passkeyModule)).to.deep.equal(["createPasskeySigner"]);
  });

  it("returns a role-neutral primary Safe-contract VaultSigner by default", () => {
    const signer = createPasskeySigner({ address: PASSKEY, deployments: verifiedDeployments(), provider: verifierProvider(), sign: async () => "0x12" });
    expect(signer).to.include({ address: PASSKEY, role: "primary", kind: "safe-contract" });
  });

  it("can be configured as a secondary Safe-contract VaultSigner", () => {
    const signer = createPasskeySigner({ address: PASSKEY, role: "secondary", deployments: verifiedDeployments(), provider: verifierProvider(), sign: async () => "0x12" });
    expect(signer).to.include({ address: PASSKEY, role: "secondary", kind: "safe-contract" });
  });

  it("returns one canonical Safe contract-signature slot", async () => {
    const raw = "0x1234" as Hex;
    const signer = testPasskeySigner(verifierProvider(), async () => raw);
    const signature = await signer.sign(request());
    expect(signature).to.equal(`0x${PASSKEY.slice(2).padStart(64, "0")}${toHex(65n, { size: 32 }).slice(2)}00${toHex(2n, { size: 32 }).slice(2)}1234`);
  });

  it("rejects a passkey response that fails the configured ERC-1271 verifier", async () => {
    const signer = testPasskeySigner(verifierProvider("0xffffffff"));
    await expect(signer.sign(request())).to.be.rejectedWith("ERC-1271");
  });

  it("rejects a mutated chain, Safe, hash, or typed-data payload", async () => {
    const signer = testPasskeySigner();
    await expect(signer.sign(request({ chainId: 1 }))).to.be.rejectedWith("chain");
    await expect(signer.sign(request({ safe: PASSKEY }))).to.be.rejectedWith("Safe");
    await expect(signer.sign(request({ safeTxHash: keccak256(toHex("other")) }))).to.be.rejectedWith("hash");
    await expect(signer.sign(request({ typedData: typedData(1, SAFE) }))).to.be.rejectedWith("typed data");
  });

  it("rejects a verifier identity that is not the configured Safe-native passkey", async () => {
    expect(() => createPasskeySigner({ address: PASSKEY, deployments: { chainId: 31337, dependencies: { passkeySignerVerifier: { address: SAFE } } } as never, provider: verifierProvider(), sign: async () => "0x12" })).to.throw("official deployment evidence");
  });

  it("does not make fabricated verified evidence into a usable passkey signer", () => {
    expect(() => createPasskeySigner({ address: PASSKEY, deployments: fabricatedDeployments() as never, provider: verifierProvider(), sign: async () => "0x12" })).to.throw("official deployment evidence");
  });

  it("does not accept a process-global fixture brand as official resolver evidence", () => {
    expect(() => createPasskeySigner({ address: PASSKEY, deployments: fabricatedDeployments(true) as never, provider: verifierProvider(), sign: async () => "0x12" })).to.throw("official deployment evidence");
  });

  it("rejects non-canonical SafeTx typed data before contacting the verifier", async () => {
    let calls = 0;
    const provider: Eip1193Provider = { request: async () => { calls++; return "0x1626ba7e"; } };
    const malformed = request({ typedData: { ...request().typedData, types: { ...request().typedData.types, Extra: [] } } as never });
    await expect(testPasskeySigner(provider).sign(malformed)).to.be.rejectedWith("canonical");
    expect(calls).to.equal(0);
  });

  it("rejects extra domain and message fields, wrong primary type, and non-SafeTx field definitions", async () => {
    const provider = verifierProvider();
    const cases = [
      { typedData: { ...request().typedData, domain: { ...request().typedData.domain, name: "Safe" } } },
      { typedData: { ...request().typedData, message: { ...request().typedData.message, extra: 1n } } },
      { typedData: { ...request().typedData, primaryType: "Other" } },
      { typedData: { ...request().typedData, types: { SafeTx: [{ name: "to", type: "bytes32" }] } } },
    ];
    for (const candidate of cases) {
      await expect(testPasskeySigner(provider).sign({ ...request(), typedData: candidate.typedData } as never)).to.be.rejectedWith(/canonical|typed data/);
    }
  });

  it("eth_call verifies the exact verifier, ERC-1271 selector/hash, and raw signature", async () => {
    const raw = "0x1234" as Hex;
    let callParams: unknown[] | undefined;
    const signer = testPasskeySigner(verifierProvider("0x1626ba7e", (params) => { callParams = params; }), async () => raw);
    const expected = request();
    await signer.sign(expected);
    expect(callParams?.[1]).to.equal("latest");
    const call = callParams?.[0] as { to: Address; data: Hex };
    expect(call.to).to.equal(PASSKEY);
    expect(call.data.slice(0, 10)).to.equal("0x1626ba7e");
    expect(call.data.slice(10, 74)).to.equal(expected.safeTxHash.slice(2));
    expect(call.data.slice(74, 138)).to.equal("0".repeat(62) + "40");
    expect(call.data.slice(138, 202)).to.equal("0".repeat(62) + "02");
    expect(call.data.slice(202)).to.equal("1234" + "0".repeat(60));
  });

  it("rejects verifier records without verified runtime evidence", async () => {
    expect(() => createPasskeySigner({ address: PASSKEY, deployments: { chainId: 31337, dependencies: { passkeySignerVerifier: { address: PASSKEY, evidence: "absent" } } } as never, provider: verifierProvider(), sign: async () => "0x12" })).to.throw("official deployment evidence");
    expect(() => createPasskeySigner({ address: PASSKEY, deployments: { chainId: 31337, dependencies: { passkeySignerVerifier: { address: PASSKEY, runtimeCodeHash: "0x12" } } } as never, provider: verifierProvider(), sign: async () => "0x12" })).to.throw("official deployment evidence");
  });

  it("rejects a verifier provider on a different chain before signing", async () => {
    let signed = false;
    const signer = testPasskeySigner(verifierProvider("0x1626ba7e", undefined, "0x1"), async () => { signed = true; return "0x12"; });
    await expect(signer.sign(request())).to.be.rejectedWith("provider chain");
    expect(signed).to.equal(false);
  });

  it("rejects a deployment evidence chain that differs from the request before signing", async () => {
    let signed = false;
    const signer = testPasskeySigner(verifierProvider(), async () => { signed = true; return "0x12"; });
    const otherChainRequest = request({ chainId: 1, typedData: typedData(1, SAFE), safeTxHash: hashTypedData(typedData(1, SAFE)) });
    await expect(signer.sign(otherChainRequest)).to.be.rejectedWith("deployment chain");
    expect(signed).to.equal(false);
  });
});
