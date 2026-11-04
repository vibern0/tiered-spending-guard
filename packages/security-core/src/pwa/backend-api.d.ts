import type { Address, Hex } from "viem";

export type PwaProvisioningTransactionId = "primary-signer" | "secondary-signer" | "setup-helper" | "guard" | "delay" | "maintenance" | "safe-proxy";
export type PwaCredentialCoordinates = Readonly<{ x: bigint; y: bigint }>;
export type PwaProvisioningTransaction = Readonly<{
  id: PwaProvisioningTransactionId;
  nonce: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  description: string;
  expectedCreatedAddress: Address;
  creationCodeHash: Hex;
  expectedRuntimeCodeHash: Hex;
}>;
export type PwaProvisioningPlan = Readonly<{
  formatVersion: 1;
  chainId: 11155111;
  deployer: Address;
  planHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  deploymentsHash: Hex;
  policyHash: Hex;
  policy: Readonly<Record<string, unknown>>;
  infrastructure: Readonly<Record<string, unknown>>;
  transactions: readonly PwaProvisioningTransaction[];
  vaultPlan: Readonly<{ safeProxySaltNonce: bigint; review?: unknown } & Record<string, unknown>>;
}>;

export type PwaProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  deploymentsHash: Hex;
  policyHash: Hex;
  setupReceipt: Readonly<{ transactionHash: Hex; blockNumber: bigint }>;
  topologyReportHash: Hex;
}>;

export type ApprovedPwaProvisioningTransaction = PwaProvisioningTransaction & Readonly<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
export type PwaProvisioningExecutionContext = Readonly<{
  confirmedPrefixLength(): Promise<number>;
  currentDeployerNonce(): Promise<bigint>;
  authorize?(transaction: PwaProvisioningTransaction): Promise<ApprovedPwaProvisioningTransaction>;
  submit(transaction: ApprovedPwaProvisioningTransaction): Promise<Readonly<{ transactionHash: Hex; receipt: Readonly<{ status: "success"; blockNumber: bigint }> }>>;
  completedSetupReceipt?(): Promise<Readonly<{ transactionHash: Hex; blockNumber: bigint }> | undefined>;
  verifyFinalTopology(plan: PwaProvisioningPlan): Promise<Hex>;
}>;

export type PwaProvisioningAutomationPolicy = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-provisioning-automation";
  chainId: 11155111;
  profileRevision: "sepolia-pwa-phase-one-v1";
  safeProxySaltNonce: 0n;
  gasMarginBps: 3000n;
  feeMarginBps: 3000n;
  maxEstimateDivergenceBps: 1000n;
  maxHeadLagBlocks: 2n;
  maxTotalOutlayWei: 50_000_000_000_000_000n;
}>;

export type PwaProvisioningQuoteClient = Readonly<{
  source: string;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; baseFeePerGas: bigint | null; gasLimit: bigint }>>;
  getTransactionCount(input: Readonly<{ address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }>): Promise<bigint | number>;
  estimateGas(input: Readonly<{ account: Address; to?: Address; data: Hex; value: bigint; blockNumber: bigint }>): Promise<bigint>;
  getMaxPriorityFeePerGas(): Promise<bigint>;
}>;
export type PwaProvisioningQuote = Readonly<{
  blockNumber: bigint;
  blockHash: Hex;
  blockGasLimit: bigint;
  baseFeePerGas: bigint;
  estimates: readonly [bigint, bigint];
  priorityFeesPerGas: readonly [bigint, bigint];
  providers: readonly [string, string];
}>;

export type PwaProvisioningAuthorizationFacts = Readonly<{
  chainId: number;
  deployer: Address;
  deployerNonce: bigint;
  packageHash: Hex;
  planHash: Hex;
  confirmedActualCost: bigint;
  pendingReservation: bigint;
  relayBalance: bigint;
  authorizedAt: string;
}>;
export type PwaProvisioningTransactionAuthorization = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-provisioning-transaction";
  packageHash: Hex;
  planHash: Hex;
  transactionId: PwaProvisioningTransactionId;
  transactionHash: Hex;
  nonce: string;
  quoteBlockNumber: string;
  quoteBlockHash: Hex;
  providers: readonly [string, string];
  gasEstimateA: string;
  gasEstimateB: string;
  priorityFeeA: string;
  priorityFeeB: string;
  baseFeePerGas: string;
  blockGasLimit: string;
  gasMarginBps: string;
  feeMarginBps: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  priorOutlayWei: string;
  resultingOutlayWei: string;
  authorizedAt: string;
  authorizationHash: Hex;
}>;
export type ProvisioningAuthorizer = Readonly<{
  authorizeTransaction(plan: PwaProvisioningPlan, transaction: PwaProvisioningTransaction, quote: PwaProvisioningQuote, facts: PwaProvisioningAuthorizationFacts): Promise<PwaProvisioningTransactionAuthorization>;
}>;

export type LiveReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint; blockHash: Hex }>;
export type LiveJournal = Readonly<{ chainId: number; funder: Address; entries: Array<{ id: string; intentHash: Hex; transactionHash: Hex; nonce: number; reserved: bigint; status: "pending" | "success" | "reverted"; receipt?: LiveReceipt }> }>;

export type PwaProvisioningRecoveryClient = Readonly<{
  source: string;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; baseFeePerGas?: bigint | null; gasLimit?: bigint }>>;
  getTransaction(input: Readonly<{ hash: Hex }>): Promise<Readonly<{ hash: Hex; chainId: number; type: "eip1559"; from: Address; to: Address | null; nonce: number; value: bigint; input: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> | null>;
  getTransactionReceipt(input: Readonly<{ hash: Hex }>): Promise<LiveReceipt | null>;
  getTransactionCount(input: Readonly<{ address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }>): Promise<number | bigint>;
  getBytecode(input: Readonly<{ address: Address }>): Promise<Hex | undefined>;
  readContract(input: Readonly<{ address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }>): Promise<unknown>;
  call(input: Readonly<{ data: Hex }>): Promise<Readonly<{ data?: Hex }>>;
}>;
export type PwaProvisioningRecovery = Readonly<{ plan: PwaProvisioningPlan; confirmedPrefixLength: number; credentials: Readonly<{ primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates }> }>;
export type PwaProvisioningSuccessor = Readonly<{ formatVersion: 1; scope: "sepolia-pwa-provisioning-successor"; chainId: 11155111; originalPackageHash: Hex; confirmedPrefixLength: 1 | 2; consumedTransactions: readonly Readonly<{ nonce: bigint; transactionHash: Hex }>[]; expectedNextNonce: bigint }>;

export type PwaProvisioningAuthorizationStore = Readonly<{ append(record: PwaProvisioningTransactionAuthorization): void; close(): void }>;

export const PWA_IDENTITY_PROVIDERS: readonly [string, string];
export function loadCommittedPwaPhaseOneProfile(): Readonly<Record<string, unknown>>;
export function loadCommittedPwaProvisioningAutomationPolicy(): PwaProvisioningAutomationPolicy;
export function createLocalPhaseOneProvisioningAuthorizer(policy?: PwaProvisioningAutomationPolicy): ProvisioningAuthorizer;
export function collectPwaProvisioningQuote(input: Readonly<{ transaction: PwaProvisioningTransaction; deployer: Address; providers: readonly [PwaProvisioningQuoteClient, PwaProvisioningQuoteClient]; relay: Pick<PwaProvisioningQuoteClient, "getBlock" | "getTransactionCount">; policy: Pick<PwaProvisioningAutomationPolicy, "chainId" | "maxEstimateDivergenceBps" | "maxHeadLagBlocks"> }>): Promise<PwaProvisioningQuote>;
export function assertPwaProvisioningTransactionAuthorization(plan: PwaProvisioningPlan, value: unknown): PwaProvisioningTransactionAuthorization;
export function createPwaProvisioningAuthorizationStore(path: string, identity: Readonly<{ chainId: 11155111; deployer: Address; packageHash: Hex; planHash: Hex }>): PwaProvisioningAuthorizationStore;
export function readLiveJournal(path: string, funder: Address): LiveJournal;
export function loadPwaProvisioningSuccessor(value: unknown): PwaProvisioningSuccessor;
export function loadCommittedPwaProvisioningSuccessor(): PwaProvisioningSuccessor;
export function loadCommittedPwaProvisioningSuccessors(): readonly PwaProvisioningSuccessor[];
export function resolvePwaProvisioningRecovery(input: Readonly<{ reviewDirectory: string; journal: LiveJournal; profile: Readonly<Record<string, unknown>>; safeProxySaltNonce: bigint; providers: readonly [PwaProvisioningRecoveryClient, PwaProvisioningRecoveryClient]; relay: Readonly<{ getTransactionCount(input: Readonly<{ address: Address; blockTag: "latest" | "pending" }>): Promise<number | bigint> }>; successor?: PwaProvisioningSuccessor; successors?: readonly PwaProvisioningSuccessor[] }>): Promise<PwaProvisioningRecovery | undefined>;
export function resolvePwaProvisioningPlan(input: Readonly<{ profile: Readonly<Record<string, unknown>>; deployer: Address; expectedDeployerNonce: bigint; expectedCurrentDeployerNonce?: bigint; successorStartingNonce?: bigint; prerequisiteStartingNonce?: bigint; confirmedSuccessorTransactionCount?: 0 | 1 | 2 | 3 | 4 | 5 | 6; safeProxySaltNonce: bigint; primaryCredential: PwaCredentialCoordinates; secondaryCredential: PwaCredentialCoordinates; client: unknown; confirmedProvisioningPrefixLength?: number; verifiedDeploymentPrefixLength?: number }>): Promise<PwaProvisioningPlan>;
export function provisioningPackageHash(plan: PwaProvisioningPlan): Hex;
export function writePwaProvisioningReview(plan: PwaProvisioningPlan, outputDirectory: string): { packageHash: Hex; path: string };
export function executePwaProvisioning(plan: PwaProvisioningPlan, context: PwaProvisioningExecutionContext): Promise<PwaProvisioningResult>;
export function createPwaProvisioningRuntime(input: Readonly<{ plan: PwaProvisioningPlan; journalPath: string; account: unknown; client: unknown; authorize?(transaction: PwaProvisioningTransaction): Promise<ApprovedPwaProvisioningTransaction> }>): Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>;
export function brandPwaProvisioningExecutionContextForTestsOnly(context: PwaProvisioningExecutionContext): PwaProvisioningExecutionContext;
