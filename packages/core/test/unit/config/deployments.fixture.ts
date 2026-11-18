import type {
  DeploymentInfrastructureInput,
  DeploymentInfrastructureRegistry,
  DeploymentInfrastructure,
  DeploymentRegistry,
  ReadOnlyDeploymentClient,
  VerifiedDeploymentInfrastructure,
} from "../../../../sdk/src/config/deployments";
import {
  resolveDeploymentInfrastructureRegistry,
  resolveVerifiedDeploymentInfrastructure,
} from "../../../../sdk/src/config/deployments";

export type { DeploymentInfrastructureRegistry };

/** Test-only fixture resolver. Production code intentionally exposes no registry argument. */
export async function resolveDeploymentInfrastructureFixture(
  client: ReadOnlyDeploymentClient,
  input: DeploymentInfrastructureInput,
  registry: DeploymentInfrastructureRegistry,
): Promise<DeploymentInfrastructure> {
  return resolveDeploymentInfrastructureRegistry(client, input, registry, {
    requireEvidence: false,
  });
}

export async function resolveDeploymentFixture(
  client: ReadOnlyDeploymentClient,
  chainId: number,
  _registry: DeploymentRegistry,
): Promise<VerifiedDeploymentInfrastructure> {
  return resolveVerifiedDeploymentInfrastructure(client, {
    chainId,
    deployer: "0x0000000000000000000000000000000000000000",
    expectedDeployerNonce: 0n,
    passkeySigner: {
      address: "0x0000000000000000000000000000000000000000",
      runtimeCodeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      bindingHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      source: "legacy fixture placeholder",
      binding: { x: 0n, y: 0n, verifiers: 0n },
    },
  });
}
