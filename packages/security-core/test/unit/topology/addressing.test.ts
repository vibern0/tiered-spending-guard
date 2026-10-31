import { readFileSync } from "node:fs";
import { expect } from "chai";
import { type Address, type Hex } from "viem";
import { deriveComponentAddresses, deriveSafeProxyAddress } from "../../../src/topology/addressing";
import { safeSmartAccountArtifact } from "../../helpers/safe-artifact";

const SAFE_PROXY_ARTIFACT = JSON.parse(
  readFileSync(
    safeSmartAccountArtifact("contracts/proxies/SafeProxy.sol/SafeProxy.json"),
    "utf8",
  ),
) as { bytecode: Hex };

describe("address derivation", () => {
  it("derives the setup helper, guard, Delay, and maintenance addresses from contiguous CREATE nonces", () => {
    expect(
      deriveComponentAddresses({
        deployer: "0x1111111111111111111111111111111111111111" as Address,
        startingNonce: 7n,
      }),
    ).to.deep.equal({
      setupHelper: "0x34E0765525c4d4D837Dc20bcb458EdD206120e59",
      guard: "0x43CeE6586B589FE6F81637bf323121087f54FEF0",
      delay: "0xA1eD4d0134858BAe8B320F13C90ab97Fb8222677",
      maintenance: "0x3f819cB883e845F7a90484699c5E35490b8d2fB6",
    });
  });

  it("rejects negative and overflowing CREATE nonces before deriving component addresses", () => {
    const deployer = "0x1111111111111111111111111111111111111111" as Address;

    expect(() => deriveComponentAddresses({ deployer, startingNonce: -1n })).to.throw("nonce");
    expect(() => deriveComponentAddresses({ deployer, startingNonce: (1n << 64n) - 3n })).to.throw("nonce");
  });

  it("matches Safe 1.5 createProxyWithNonce CREATE2 derivation for the canonical Sepolia factory", () => {
    const base = {
      factory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b" as Address,
      singleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b" as Address,
      proxyCreationCode: SAFE_PROXY_ARTIFACT.bytecode,
      initializer: "0xdeadbeef" as Hex,
      saltNonce: 123n,
    };

    expect(deriveSafeProxyAddress(base)).to.equal("0x3c9327F971b85954351ffB1027c4e9F9c72b6E5d");
    expect(deriveSafeProxyAddress({ ...base, initializer: "0xdeadbeee" as Hex })).to.equal(
      "0xdC0faDF50FCBB7e3BB4fD20e328a8bc4478AD97C",
    );
    expect(deriveSafeProxyAddress({ ...base, singleton: "0x0000000000000000000000000000000000000001" as Address })).to.not.equal(
      "0x3c9327F971b85954351ffB1027c4e9F9c72b6E5d",
    );
    expect(deriveSafeProxyAddress({ ...base, factory: "0x0000000000000000000000000000000000000002" as Address })).to.not.equal(
      "0x3c9327F971b85954351ffB1027c4e9F9c72b6E5d",
    );
    expect(deriveSafeProxyAddress({ ...base, saltNonce: 124n })).to.not.equal(
      "0x3c9327F971b85954351ffB1027c4e9F9c72b6E5d",
    );
  });

  it("rejects invalid Safe proxy derivation inputs", () => {
    const base = {
      factory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b" as Address,
      singleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b" as Address,
      proxyCreationCode: SAFE_PROXY_ARTIFACT.bytecode,
      initializer: "0xdeadbeef" as Hex,
      saltNonce: 123n,
    };

    expect(() => deriveSafeProxyAddress({ ...base, saltNonce: -1n })).to.throw("salt nonce");
    expect(() => deriveSafeProxyAddress({ ...base, proxyCreationCode: "0x" as Hex })).to.throw("proxy creation code");
  });
});
