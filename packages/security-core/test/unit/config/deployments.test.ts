import { expect } from "chai";
import {
  OFFICIAL_DEPLOYMENT_REGISTRY,
  assertReviewedSafePasskeySignerProxyArtifact,
  isVerifiedDeploymentInfrastructure,
  resolvePasskeySignerRuntimeCodeHash,
  resolvePwaSignerRuntimeCodeHashes,
  verifyOfficialDeploymentDependencies,
} from "../../../src/config/deployments";
import SafeWebAuthnSignerProxyArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerProxy.sol/SafeWebAuthnSignerProxy.json";
import { network } from "hardhat";
import { keccak256, type Address, type Hex } from "viem";

const CHAIN_ID = 11155111;

describe("deployment registry", () => {
  it("rejects substituted Safe passkey signer proxy creation code", () => {
    expect(assertReviewedSafePasskeySignerProxyArtifact(SafeWebAuthnSignerProxyArtifact)).to.equal(SafeWebAuthnSignerProxyArtifact.bytecode);
    expect(() => assertReviewedSafePasskeySignerProxyArtifact({ ...SafeWebAuthnSignerProxyArtifact, bytecode: "0x6000" })).to.throw(/creation code hash/i);
  });

  it("derives distinct credential-bound signer runtime hashes through EVM creation simulation", async () => {
    const client = {
      async call({ data }: { data: Hex }) {
        const result = await network.provider.send("eth_call", [{ data }, "latest"]);
        return { data: result as Hex };
      },
    };
    const common = {
      client,
      singleton: "0x0000000000000000000000000000000000000011" as Address,
      verifiers: 0x22n,
    };

    const primary = await resolvePasskeySignerRuntimeCodeHash({ ...common, credential: { x: 1n, y: 2n } });
    const secondary = await resolvePasskeySignerRuntimeCodeHash({ ...common, credential: { x: 3n, y: 4n } });

    expect(primary).to.match(/^0x[0-9a-f]{64}$/);
    expect(secondary).to.match(/^0x[0-9a-f]{64}$/);
    expect(primary).not.to.equal(secondary);
  });

  it("rejects a simulation provider that returns one runtime for distinct credentials", async () => {
    await expect(resolvePwaSignerRuntimeCodeHashes({
      client: { async call() { return { data: "0x6000" as Hex }; } },
      singleton: "0x0000000000000000000000000000000000000011" as Address,
      primaryCredential: { x: 1n, y: 2n },
      secondaryCredential: { x: 3n, y: 4n },
      verifiers: 0x22n,
    })).to.be.rejectedWith(/distinct signer runtime hashes/i);
  });

  it("pins the Safe 1.5 Sepolia MultiSendCallOnly official deployment evidence", () => {
    const entry = OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.multiSendCallOnly;

    expect(entry.name).to.equal("Safe MultiSendCallOnly");
    expect(entry.version).to.equal("1.5.0");
    expect(entry.address).to.equal("0xA83c336B20401Af773B6219BA5027174338D1836");
    expect(entry.runtimeCodeHash).to.equal("0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663");
    expect(entry.source).to.contain("@safe-global/safe-deployments");
  });

  it("pins the official Safe passkey factory and Daimo verifier deployment evidence", () => {
    const factory = OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.passkeySignerFactory;
    const verifier = OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.passkeySignerVerifier;

    expect(factory).to.include({
      name: "Safe WebAuthn signer factory",
      version: "0.2.0",
      address: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf",
      runtimeCodeHash: "0xbe9db61b4ee533cb4b1136ef244141db4ca3b7867b44d154db9faeb22f39d7bb",
      evidence: "verified",
    });
    expect(verifier).to.include({
      name: "Daimo P-256 verifier",
      version: "0.2.0",
      address: "0xc2b78104907F722DABAc4C69f826a522B2754De4",
      runtimeCodeHash: "0x3cd725b6ba67b40b7979190c41a015e82cf21e098eb61832ba623f8538bab7fc",
      evidence: "verified",
    });
  });

  it("does not let config-shaped JSON construct the production infrastructure brand", () => {
    const cloned = {
      chainId: CHAIN_ID,
      deployer: "0x0000000000000000000000000000000000000001",
      observedDeployerNonce: 0n,
      safeSingleton: OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.safeSingleton,
      safeProxyFactory: OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.safeProxyFactory,
      passkeySignerFactory: OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.passkeySignerFactory,
      passkeySignerVerifier: OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.passkeySignerVerifier,
      multiSendCallOnly: OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!.multiSendCallOnly,
      passkeySigner: {
        name: "passkeySigner",
        address: "0x0000000000000000000000000000000000000002",
        runtimeCodeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        bindingHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        source: "test",
      },
    };

    expect(isVerifiedDeploymentInfrastructure(cloned)).to.equal(false);
  });

  it("verifies every pinned official dependency without requiring a credential-specific signer", async () => {
    const chain = OFFICIAL_DEPLOYMENT_REGISTRY[CHAIN_ID]!;
    const code = "0x6001" as Hex;
    const verified = await verifyOfficialDeploymentDependencies({
      getBytecode: async ({ address }: { address: Address }) => {
        expect(Object.values(chain).some((record) => record.address?.toLowerCase() === address.toLowerCase())).to.equal(true);
        return code;
      },
    }, CHAIN_ID, { [CHAIN_ID]: Object.fromEntries(Object.entries(chain).map(([name, record]) => [name, { ...record, runtimeCodeHash: keccak256(code) }])) } as typeof OFFICIAL_DEPLOYMENT_REGISTRY);
    expect(Object.keys(verified)).to.have.length(5);
  });
});
