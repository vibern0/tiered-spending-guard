import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import {
  OFFICIAL_DEPLOYMENT_REGISTRY,
  resolveVerifiedDeploymentInfrastructure,
  verifyOfficialDeploymentDependencies,
} from "@tiered-spending-guard/sdk/config/deployments";

const chain = OFFICIAL_DEPLOYMENT_REGISTRY[sepolia.id];
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live dependency verification`);
  return value;
};

async function main(): Promise<void> {
  if (!chain) throw new Error("Sepolia dependency registry missing");
  const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const base = await verifyOfficialDeploymentDependencies(client, sepolia.id);
  console.log(`verified ${Object.keys(base).length} pinned public dependencies on chain ${sepolia.id}`);
  if (!process.env.PASSKEY_SIGNER_ADDRESS) {
    console.log("credential-specific passkey signer verification deferred until bootstrap creates it");
    return;
  }
  const verified = await resolveVerifiedDeploymentInfrastructure(client, {
    chainId: sepolia.id,
    deployer: required("DEPLOYER_ADDRESS") as Address,
    expectedDeployerNonce: BigInt(required("DEPLOYER_EXPECTED_NONCE")),
    passkeySigner: {
      address: required("PASSKEY_SIGNER_ADDRESS") as Address,
      runtimeCodeHash: required("PASSKEY_SIGNER_RUNTIME_CODE_HASH") as Hex,
      bindingHash: required("PASSKEY_SIGNER_BINDING_HASH") as Hex,
      source: "operator-provided task-3 evidence",
      binding: {
        x: BigInt(required("PASSKEY_SIGNER_X")),
        y: BigInt(required("PASSKEY_SIGNER_Y")),
        verifiers: BigInt(required("PASSKEY_SIGNER_VERIFIERS")),
      },
    },
  });
  console.log(`verified deployment infrastructure on chain ${verified.chainId}`);
}

void main();
