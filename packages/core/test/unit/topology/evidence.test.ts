import { expect } from "chai";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import {
  resolveDeploymentInfrastructureFixture,
  type DeploymentInfrastructureRegistry,
} from "../config/deployments.fixture";
import {
  resolveVerifiedDeploymentInfrastructure,
  isVerifiedDeploymentInfrastructure,
  type ReadOnlyDeploymentClient,
} from "../../../../sdk/src/config/deployments";

const CHAIN_ID = 11155111;
const CODE = "0x6001600055" as Hex;
const CODE_HASH = keccak256(CODE);
const PASSKEY_CODE = "0x6002600055" as Hex;
const PASSKEY_CODE_HASH = keccak256(PASSKEY_CODE);
const X = 1n;
const Y = 2n;
const VERIFIERS = 3n;

const addresses = {
  safeSingleton: "0x0000000000000000000000000000000000000001" as Address,
  safeProxyFactory: "0x0000000000000000000000000000000000000002" as Address,
  passkeySignerFactory: "0x0000000000000000000000000000000000000003" as Address,
  passkeySignerVerifier: "0x0000000000000000000000000000000000000004" as Address,
  multiSendCallOnly: "0x0000000000000000000000000000000000000005" as Address,
  passkeySigner: "0x0000000000000000000000000000000000000006" as Address,
  deployer: "0x0000000000000000000000000000000000000007" as Address,
};

const bindingHash = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
    [addresses.passkeySignerFactory, X, Y, VERIFIERS],
  ),
);

const fixtureRegistry = (): DeploymentInfrastructureRegistry => ({
  [CHAIN_ID]: {
    safeSingleton: {
      name: "Safe singleton",
      version: "1.5.0",
      address: addresses.safeSingleton,
      runtimeCodeHash: CODE_HASH,
      supportsModuleGuards: true,
      source: "fixture",
    },
    safeProxyFactory: {
      name: "Safe proxy factory",
      version: "1.5.0",
      address: addresses.safeProxyFactory,
      runtimeCodeHash: CODE_HASH,
      source: "fixture",
    },
    passkeySignerFactory: {
      name: "Safe passkey signer factory",
      version: "0.2.0",
      address: addresses.passkeySignerFactory,
      runtimeCodeHash: CODE_HASH,
      source: "fixture",
    },
    passkeySignerVerifier: {
      name: "Safe passkey verifier",
      version: "0.2.0",
      address: addresses.passkeySignerVerifier,
      runtimeCodeHash: CODE_HASH,
      source: "fixture",
    },
    multiSendCallOnly: {
      name: "Safe MultiSendCallOnly",
      version: "1.5.0",
      address: addresses.multiSendCallOnly,
      runtimeCodeHash: CODE_HASH,
      source: "fixture",
    },
  },
});

const input = {
  chainId: CHAIN_ID,
  deployer: addresses.deployer,
  expectedDeployerNonce: 17n,
  passkeySigner: {
    address: addresses.passkeySigner,
    runtimeCodeHash: PASSKEY_CODE_HASH,
    binding: { x: X, y: Y, verifiers: VERIFIERS },
    bindingHash,
    source: "fixture signer",
  },
} as const;

const clientFor = (
  overrides: Partial<{
    codeByAddress: Partial<Record<Address, Hex | undefined>>;
    deployerNonce: bigint;
    signerForBinding: Address;
  }> = {},
): ReadOnlyDeploymentClient => {
  const codeByAddress = overrides.codeByAddress ?? {};
  return {
    getBytecode: async ({ address }) => codeByAddress[address] ?? (address === addresses.passkeySigner ? PASSKEY_CODE : CODE),
    getTransactionCount: async ({ address }) => {
      expect(address).to.equal(addresses.deployer);
      return overrides.deployerNonce ?? 17n;
    },
    readContract: async ({ address, functionName, args }) => {
      expect(address).to.equal(addresses.passkeySignerFactory);
      expect(functionName).to.equal("getSigner");
      expect(args).to.deep.equal([X, Y, VERIFIERS]);
      return overrides.signerForBinding ?? addresses.passkeySigner;
    },
  };
};

describe("vault evidence", () => {
  it("verifies injected-registry infrastructure without minting the production brand", async () => {
    const result = await resolveDeploymentInfrastructureFixture(clientFor(), input, fixtureRegistry());

    expect(isVerifiedDeploymentInfrastructure(result)).to.equal(false);
    expect(result.chainId).to.equal(CHAIN_ID);
    expect(result.deployer).to.equal(addresses.deployer);
    expect(result.observedDeployerNonce).to.equal(17n);
    expect(result.multiSendCallOnly.address).to.equal(addresses.multiSendCallOnly);
    expect(result.passkeySigner).to.deep.equal({
      name: "passkeySigner",
      address: addresses.passkeySigner,
      runtimeCodeHash: PASSKEY_CODE_HASH,
      bindingHash,
      source: "fixture signer",
    });
  });

  it("rejects absent code and code-hash mismatches", async () => {
    await expect(
      resolveDeploymentInfrastructureFixture(
        clientFor({ codeByAddress: { [addresses.passkeySigner]: "0x" as Hex } }),
        input,
        fixtureRegistry(),
      ),
    ).to.be.rejectedWith("passkeySigner at");

    await expect(
      resolveDeploymentInfrastructureFixture(
        clientFor({ codeByAddress: { [addresses.safeProxyFactory]: "0x6003" as Hex } }),
        input,
        fixtureRegistry(),
      ),
    ).to.be.rejectedWith("runtime code hash mismatch");
  });

  it("rejects passkey signer address and binding mismatches", async () => {
    await expect(
      resolveDeploymentInfrastructureFixture(
        clientFor({ signerForBinding: "0x0000000000000000000000000000000000000008" as Address }),
        input,
        fixtureRegistry(),
      ),
    ).to.be.rejectedWith("passkey signer binding mismatch");

    await expect(
      resolveDeploymentInfrastructureFixture(
        clientFor(),
        { ...input, passkeySigner: { ...input.passkeySigner, bindingHash: CODE_HASH } },
        fixtureRegistry(),
      ),
    ).to.be.rejectedWith("passkey signer binding hash mismatch");
  });

  it("rejects a changed deployment sender nonce before branding infrastructure", async () => {
    await expect(
      resolveDeploymentInfrastructureFixture(clientFor({ deployerNonce: 18n }), input, fixtureRegistry()),
    ).to.be.rejectedWith("deployer nonce changed");
  });

  it("keeps the production resolver fail-closed when live public dependency code differs from its pin", async () => {
    await expect(resolveVerifiedDeploymentInfrastructure(clientFor(), input)).to.be.rejectedWith(
      "runtime code hash mismatch",
    );
  });
});
