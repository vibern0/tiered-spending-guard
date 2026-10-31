import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { concatHex, encodeAbiParameters, isAddress, type Address, type Hex } from "viem";

export const ZODIAC_DELAY_V1_1_1 = Object.freeze({
  version: "1.1.1",
  compilerVersion: "v0.8.20+commit.a1b79de6",
  sourceUrl: "https://raw.githubusercontent.com/gnosisguild/zodiac-modifier-delay/30f3aafa9b3be3425bcac390fe6ab6bd9afb5f16/mastercopies.json",
  sourceSha256: "0xad367f67b4c8b691d93417ecd740eeefc9abfff50a789469ba5899c0b5aa9201",
  mastercopy: "0x824175b945838d127C1ca83CbcE11D8e44F6dF01" as Address,
});

export type ZodiacDelayArtifact = Readonly<{
  contractVersion: "1.1.1";
  compilerVersion: "v0.8.20+commit.a1b79de6";
  creationBytecode: Hex;
  mastercopy: Address;
}>;

type ArtifactRecord = Readonly<{
  contractName?: unknown;
  sourceName?: unknown;
  contractVersion?: unknown;
  compilerVersion?: unknown;
  address?: unknown;
  bytecode?: unknown;
  constructorArgs?: Readonly<{ types?: unknown; values?: unknown }>;
  abi?: unknown;
}>;

const CONSTRUCTOR_TYPES = ["address", "address", "address", "uint256", "uint256"] as const;

function sha256(value: string): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function isHexBytecode(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseZodiacDelayArtifactWithDigest(source: string, expectedSourceSha256: Hex): ZodiacDelayArtifact {
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedSourceSha256)) throw new Error("Delay source digest must be a 32-byte hash");
  if (!same(sha256(source), expectedSourceSha256)) throw new Error("Delay source digest mismatch");

  let parsed: { Delay?: Record<string, ArtifactRecord> };
  try { parsed = JSON.parse(source) as { Delay?: Record<string, ArtifactRecord> }; }
  catch { throw new Error("Delay artifact JSON is invalid"); }
  const artifact = parsed.Delay?.[ZODIAC_DELAY_V1_1_1.version];
  if (!artifact) throw new Error("Delay v1.1.1 artifact is missing");
  if (artifact.contractName !== "Delay" || artifact.sourceName !== "contracts/Delay.sol" || artifact.contractVersion !== ZODIAC_DELAY_V1_1_1.version) {
    throw new Error("Delay artifact identity mismatch");
  }
  if (artifact.compilerVersion !== ZODIAC_DELAY_V1_1_1.compilerVersion) throw new Error("Delay compiler version mismatch");
  if (!isAddress(artifact.address) || !same(artifact.address, ZODIAC_DELAY_V1_1_1.mastercopy)) throw new Error("Delay mastercopy mismatch");
  if (!isHexBytecode(artifact.bytecode)) throw new Error("Delay creation bytecode is invalid");
  if (!Array.isArray(artifact.constructorArgs?.types) || artifact.constructorArgs.types.length !== CONSTRUCTOR_TYPES.length || artifact.constructorArgs.types.some((value, index) => value !== CONSTRUCTOR_TYPES[index])) {
    throw new Error("Delay constructor schema mismatch");
  }
  if (!Array.isArray(artifact.constructorArgs.values) || artifact.constructorArgs.values.length !== CONSTRUCTOR_TYPES.length) throw new Error("Delay constructor values mismatch");
  if (!Array.isArray(artifact.abi)) throw new Error("Delay ABI is missing");

  return Object.freeze({
    contractVersion: "1.1.1",
    compilerVersion: "v0.8.20+commit.a1b79de6",
    creationBytecode: artifact.bytecode,
    mastercopy: ZODIAC_DELAY_V1_1_1.mastercopy,
  });
}

/** Parses only the committed upstream artifact in production. */
export function parseZodiacDelayArtifact(source: string): ZodiacDelayArtifact {
  return parseZodiacDelayArtifactWithDigest(source, ZODIAC_DELAY_V1_1_1.sourceSha256);
}

/** Loads the exact reviewed upstream bytes committed with the repository. */
export function loadCommittedZodiacDelayArtifact(): ZodiacDelayArtifact {
  const source = readFileSync(join(__dirname, "../../config/artifacts/zodiac-delay-v1.1.1-mastercopies.json"), "utf8");
  return parseZodiacDelayArtifact(source);
}

/** Test fixture escape hatch for adversarial parser coverage. */
export function parseZodiacDelayArtifactForTestsOnly(source: string, expectedSourceSha256: Hex): ZodiacDelayArtifact {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") {
    throw new Error("test-only Delay source digest override is disabled outside tests");
  }
  return parseZodiacDelayArtifactWithDigest(source, expectedSourceSha256);
}

export function zodiacDelayCreationCode(
  artifact: ZodiacDelayArtifact,
  input: Readonly<{ safe: Address; cooldownSeconds: bigint; expirationSeconds: bigint }>,
): Hex {
  if (!isAddress(input.safe)) throw new Error("Delay Safe address is invalid");
  if (input.cooldownSeconds <= 0n || input.expirationSeconds <= input.cooldownSeconds) throw new Error("Delay timing is invalid");
  return concatHex([
    artifact.creationBytecode,
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [input.safe, input.safe, input.safe, input.cooldownSeconds, input.expirationSeconds],
    ),
  ]);
}
