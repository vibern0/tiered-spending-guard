import { isAddress, type Address } from "viem";
import type { DependencyName, DeploymentRecord } from "./deployments";

export const EXPECTED_RELEASES: Readonly<Record<DependencyName, readonly string[]>> = Object.freeze({
  safeSingleton: ["1.5.0"],
  safeProxyFactory: ["1.5.0"],
  passkeySignerFactory: ["0.2.0"],
  passkeySignerVerifier: ["0.2.0"],
  multiSendCallOnly: ["1.5.0"],
});

export const DEPENDENCIES = Object.freeze(Object.keys(EXPECTED_RELEASES) as DependencyName[]);

export function deploymentAddressError(dependency: DependencyName, record: DeploymentRecord): string | undefined {
  if (!record.address) return `${dependency} has no official deployment evidence`;
  if (!isAddress(record.address)) return `${dependency} has invalid address`;
  if (record.address.toLowerCase() === "0x0000000000000000000000000000000000000000") return `${dependency} has zero address`;
  return undefined;
}

export function deploymentReleaseError(dependency: DependencyName, record: DeploymentRecord): string | undefined {
  if (!EXPECTED_RELEASES[dependency].includes(record.version)) return `unknown release ${record.version} for ${dependency}`;
  if (dependency === "safeSingleton" && record.supportsModuleGuards !== true) return `Safe release ${record.version} lacks module guards`;
  return undefined;
}

export function validatedDeploymentAddress(dependency: DependencyName, record: DeploymentRecord): Address {
  const error = deploymentAddressError(dependency, record);
  if (error) throw new Error(error);
  return record.address as Address;
}
