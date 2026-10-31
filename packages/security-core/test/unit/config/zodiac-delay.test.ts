import { expect } from "chai";
import { createHash } from "node:crypto";
import { encodeAbiParameters, type Address } from "viem";
import {
  loadCommittedZodiacDelayArtifact,
  parseZodiacDelayArtifact,
  parseZodiacDelayArtifactForTestsOnly,
  zodiacDelayCreationCode,
} from "../../../src/config/zodiac-delay";

process.env.NODE_ENV = "test";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const source = JSON.stringify({
  Delay: {
    "1.1.1": {
      contractName: "Delay",
      sourceName: "contracts/Delay.sol",
      contractVersion: "1.1.1",
      compilerVersion: "v0.8.20+commit.a1b79de6",
      factory: address(9),
      address: "0x824175b945838d127C1ca83CbcE11D8e44F6dF01",
      bytecode: "0x60006000",
      constructorArgs: {
        types: ["address", "address", "address", "uint256", "uint256"],
        values: [address(1), address(1), address(1), 0, 0],
      },
      salt: "0x00",
      abi: [{ type: "function", name: "executeNextTx" }],
      compilerInput: {},
    },
  },
});
const digest = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}` as `0x${string}`;

describe("pinned Zodiac Delay artifact", () => {
  it("loads the exact committed v1.1.1 deployment artifact for production planning", () => {
    const artifact = loadCommittedZodiacDelayArtifact();

    expect(artifact.contractVersion).to.equal("1.1.1");
    expect(artifact.compilerVersion).to.equal("v0.8.20+commit.a1b79de6");
    expect(artifact.mastercopy).to.equal("0x824175b945838d127C1ca83CbcE11D8e44F6dF01");
    expect(artifact.creationBytecode).to.match(/^0x[0-9a-f]+$/i);
  });

  it("accepts only the exact source digest and v1.1.1 artifact shape", () => {
    const artifact = parseZodiacDelayArtifactForTestsOnly(source, digest(source));

    expect(artifact.contractVersion).to.equal("1.1.1");
    expect(artifact.compilerVersion).to.equal("v0.8.20+commit.a1b79de6");
    expect(artifact.creationBytecode).to.equal("0x60006000");
    expect(() => parseZodiacDelayArtifactForTestsOnly(source, "0x" + "00".repeat(32))).to.throw("source digest mismatch");
  });

  it("binds the fresh Delay creation code to the intended Safe and timing", () => {
    const artifact = parseZodiacDelayArtifactForTestsOnly(source, digest(source));
    const creationCode = zodiacDelayCreationCode(artifact, {
      safe: address(2),
      cooldownSeconds: 120n,
      expirationSeconds: 600n,
    });

    expect(creationCode).to.equal(`0x60006000${encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [address(2), address(2), address(2), 120n, 600n],
    ).slice(2)}`);
  });

  it("rejects a substituted compiler, constructor schema, or non-hex creation bytecode", () => {
    const expectedDigest = digest(source);
    const parsed = JSON.parse(source);
    parsed.Delay["1.1.1"].compilerVersion = "v0.8.19";
    const changedCompiler = JSON.stringify(parsed);
    expect(() => parseZodiacDelayArtifactForTestsOnly(changedCompiler, digest(changedCompiler))).to.throw("compiler version");

    parsed.Delay["1.1.1"].compilerVersion = "v0.8.20+commit.a1b79de6";
    parsed.Delay["1.1.1"].constructorArgs.types = ["address"];
    const changedConstructor = JSON.stringify(parsed);
    expect(() => parseZodiacDelayArtifactForTestsOnly(changedConstructor, digest(changedConstructor))).to.throw("constructor schema");

    expect(expectedDigest).to.match(/^0x[0-9a-f]{64}$/);
  });
});
