import type { Address, Hex } from "viem";

export type PwaProvisioningPlan = Readonly<{
  planHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
}>;

export type PwaProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  setupReceipt: Readonly<{ transactionHash: Hex; blockNumber: bigint }>;
  topologyReportHash: Hex;
}>;

export type PwaProvisioningExecutionContext = Readonly<{
  currentDeployerNonce(): Promise<bigint>;
  submit(transaction: unknown): Promise<Readonly<{ transactionHash: Hex; receipt: Readonly<{ status: "success"; blockNumber: bigint }> }>>;
  verifyFinalTopology(plan: PwaProvisioningPlan): Promise<Hex>;
}>;

export function provisioningPackageHash(plan: PwaProvisioningPlan): Hex;
export function writePwaProvisioningReview(plan: PwaProvisioningPlan, outputDirectory: string): { packageHash: Hex; path: string };
export function executeApprovedPwaProvisioning(plan: PwaProvisioningPlan, approval: unknown, context: PwaProvisioningExecutionContext): Promise<PwaProvisioningResult>;
