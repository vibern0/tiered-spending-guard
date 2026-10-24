import type { Address, Hex } from "viem";
import type { VaultDeploymentPlan } from "../../src/topology/build";
import { loadReviewedVaultPrerequisiteApproval } from "./vault-runner";

type HistoricalReadClient = Readonly<{
  getBytecode(args: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getTransactionCount(args: { address: Address; blockNumber?: bigint }): Promise<number>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  call(args: { data: Hex; blockNumber?: bigint }): Promise<{ data?: Hex }>;
}>;

/** Keeps original-plan reconstruction tied to the real pre-prerequisite RPC snapshot. */
export function createPinnedSafeReviewClient(client: HistoricalReadClient, blockNumber: bigint) {
  if (blockNumber <= 0n) throw new Error("reviewed historical snapshot block is invalid");
  return Object.freeze({
    getBytecode: ({ address }: { address: Address }) => client.getBytecode({ address, blockNumber }),
    getTransactionCount: ({ address }: { address: Address }) => client.getTransactionCount({ address, blockNumber }),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => client.readContract({ ...args, blockNumber }),
    call: ({ data }: { data: Hex }) => client.call({ data, blockNumber }),
  });
}

/** Reuses the strict four-file loader, including canonical plan and decoded Safe tuple checks. */
export function bindSafeCreationPrerequisitePackage(plan: VaultDeploymentPlan, directory: string, expectedPackageHash: Hex) {
  return loadReviewedVaultPrerequisiteApproval(plan, directory, expectedPackageHash);
}
