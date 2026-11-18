import { expect } from "chai";
import { decodeAbiParameters, type Address } from "viem";
import { buildVaultPrerequisiteCreationCodes } from "../../../../sdk/src/live/vault-deployment";
import { type ZodiacDelayArtifact } from "../../../../sdk/src/config/zodiac-delay";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const delayArtifact: ZodiacDelayArtifact = {
  contractVersion: "1.1.1",
  compilerVersion: "v0.8.20+commit.a1b79de6",
  creationBytecode: "0x60006000",
  mastercopy: "0x824175b945838d127C1ca83CbcE11D8e44F6dF01",
};

describe("vault prerequisite deployment payloads", () => {
  it("binds guard, Delay, and maintenance constructors to one derived Safe", () => {
    const result = buildVaultPrerequisiteCreationCodes({
      safe: address(1),
      primaryPasskey: address(2),
      ecdsaSecondary: address(3),
      delay: address(4),
      maintenance: address(5),
      periodAnchor: 0n,
      cooldownSeconds: 120n,
      expirationSeconds: 600n,
      delayArtifact,
    });

    expect(result.setupHelper).to.match(/^0x[0-9a-f]+$/);
    expect(result.guard).to.match(/^0x[0-9a-f]+$/);
    expect(result.delay).to.equal(`0x60006000${result.delay.slice(-320)}`);
    expect(decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      `0x${result.delay.slice(-320)}`,
    )).to.deep.equal([address(1), address(1), address(1), 120n, 600n]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], `0x${result.maintenance.slice(-192)}`)).to.deep.equal([address(1), address(4), address(5)]);
  });
});
