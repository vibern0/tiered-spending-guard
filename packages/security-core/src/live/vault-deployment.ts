import { concatHex, encodeAbiParameters, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import GuardArtifact from "../../artifacts/contracts/TieredSpendingGuard.sol/TieredSpendingGuard.json";
import SetupHelperArtifact from "../../artifacts/contracts/SafeAtomicSetupHelper.sol/SafeAtomicSetupHelper.json";
import MaintenanceArtifact from "../../artifacts/contracts/GuardReplacementMaintenance.sol/GuardReplacementMaintenance.json";
import { zodiacDelayCreationCode, type ZodiacDelayArtifact } from "../config/zodiac-delay";

type Artifact = Readonly<{ bytecode: Hex }>;

function reviewedArtifact(name: string, fallback: Artifact): Artifact {
  if (process.env.SOLIDITY_COVERAGE !== "true") return fallback;
  const directory = process.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT;
  if (!directory) throw new Error("coverage reviewed-artifact snapshot is unavailable");
  const artifact = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<Artifact>;
  if (typeof artifact.bytecode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(artifact.bytecode)) throw new Error(`coverage ${name} bytecode is invalid`);
  return Object.freeze({ bytecode: artifact.bytecode as Hex });
}

const guardArtifact = reviewedArtifact("TieredSpendingGuard.json", GuardArtifact as Artifact);
const setupHelperArtifact = reviewedArtifact("SafeAtomicSetupHelper.json", SetupHelperArtifact as Artifact);
const maintenanceArtifact = reviewedArtifact("GuardReplacementMaintenance.json", MaintenanceArtifact as Artifact);

export type VaultPrerequisiteCreationCodes = Readonly<{
  setupHelper: Hex;
  guard: Hex;
  delay: Hex;
  maintenance: Hex;
}>;

export function buildVaultPrerequisiteCreationCodes(input: Readonly<{
  safe: Address;
  primaryPasskey: Address;
  ecdsaSecondary: Address;
  delay: Address;
  maintenance: Address;
  periodAnchor: bigint;
  cooldownSeconds: bigint;
  expirationSeconds: bigint;
  delayArtifact: ZodiacDelayArtifact;
}>): VaultPrerequisiteCreationCodes {
  const guard = concatHex([
    guardArtifact.bytecode,
    encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address", name: "safe" }, { type: "address", name: "passkey" }, { type: "address", name: "ecdsaSecondary" }, { type: "address", name: "delay" }, { type: "uint64", name: "periodSeconds" }, { type: "uint64", name: "periodAnchor" }] }],
      [[input.safe, input.primaryPasskey, input.ecdsaSecondary, input.delay, 86400n, input.periodAnchor]],
    ),
  ]);
  const maintenance = concatHex([
    maintenanceArtifact.bytecode,
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [input.safe, input.delay, input.maintenance]),
  ]);

  return Object.freeze({
    setupHelper: setupHelperArtifact.bytecode,
    guard,
    delay: zodiacDelayCreationCode(input.delayArtifact, input),
    maintenance,
  });
}
