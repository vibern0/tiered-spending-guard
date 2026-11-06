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
  resumePending?(transaction: PwaProvisioningTransaction): Promise<Readonly<{ transactionHash: Hex; receipt: Readonly<{ status: "success"; blockNumber: bigint }> }> | undefined>;
  submit(transaction: ApprovedPwaProvisioningTransaction): Promise<Readonly<{ transactionHash: Hex; receipt: Readonly<{ status: "success"; blockNumber: bigint }> }>>;
  completedSetupReceipt?(): Promise<Readonly<{ transactionHash: Hex; blockNumber: bigint }> | undefined>;
  verifyFinalTopology(plan: PwaProvisioningPlan): Promise<Hex>;
  currentPolicyHash?(): Promise<Hex>;
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

export type PwaProvisioningRecoveryTransaction = Readonly<{ hash: Hex; chainId: number; type: "eip1559"; from: Address; to: Address | null; nonce: number; value: bigint; input: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
export type PwaProvisioningRecoveryClient = Readonly<{
  source: string;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; baseFeePerGas?: bigint | null; gasLimit?: bigint }>>;
  getBlockWithTransactions?(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; transactions: readonly PwaProvisioningRecoveryTransaction[] }>>;
  getTransaction(input: Readonly<{ hash: Hex }>): Promise<PwaProvisioningRecoveryTransaction | null>;
  getTransactionReceipt(input: Readonly<{ hash: Hex }>): Promise<LiveReceipt | null>;
  getTransactionCount(input: Readonly<{ address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }>): Promise<number | bigint>;
  getBytecode(input: Readonly<{ address: Address }>): Promise<Hex | undefined>;
  readContract(input: Readonly<{ address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }>): Promise<unknown>;
  call(input: Readonly<{ data: Hex }>): Promise<Readonly<{ data?: Hex }>>;
}>;
export type PwaProvisioningRecovery = Readonly<{ plan: PwaProvisioningPlan; confirmedPrefixLength: number; credentials: Readonly<{ primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates }> }>;
export type HistoricalPwaReadClient = PwaProvisioningRecoveryClient & Readonly<{
  getBytecode(input: Readonly<{ address: Address; blockNumber?: bigint }>): Promise<Hex | undefined>;
  getStorageAt(input: Readonly<{ address: Address; slot: Hex; blockNumber?: bigint }>): Promise<Hex | undefined>;
  readContract(input: Readonly<{ address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }>): Promise<unknown>;
}>;
export type PwaHistoricalVault = Readonly<{
  mode: "read-only";
  profileVersion: "sepolia-pwa-phase-one-allowlisted-v1";
  chainId: 11155111;
  safe: Address; guard: Address; delay: Address; primaryPasskey: Address; secondaryPasskey: Address; usdc: Address;
  policy: Readonly<{ recipientMode: "all-lanes-allowlisted"; assets: readonly Readonly<{ token: Address; basePerTransaction: string; stepUpPerTransaction: string; baseDailyLimit: string; instantDailyLimit: string; recipients: readonly Address[] }>[] }>;
  evidence: Readonly<{ originalPackageHash: Hex; packageHash: Hex; planHash: Hex; policyHash: Hex; setupTransactionHash: Hex; topologyReportHash: Hex; blockNumber: string; blockHash: Hex }>;
}>;
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
export function acquireLocalWriterLease(lockPath: string): Readonly<{ close(): void }>;
export function loadPwaProvisioningSuccessor(value: unknown): PwaProvisioningSuccessor;
export function loadCommittedPwaProvisioningSuccessor(): PwaProvisioningSuccessor;
export function loadCommittedPwaProvisioningSuccessors(): readonly PwaProvisioningSuccessor[];
export type ResolvePwaProvisioningRecoveryInput = Readonly<{ reviewDirectory: string; journal: LiveJournal; profile: Readonly<Record<string, unknown>>; safeProxySaltNonce: bigint; providers: readonly [PwaProvisioningRecoveryClient, PwaProvisioningRecoveryClient]; relay: Readonly<{ getTransactionCount(input: Readonly<{ address: Address; blockTag: "latest" | "pending" }>): Promise<number | bigint> }>; successor?: PwaProvisioningSuccessor; successors?: readonly PwaProvisioningSuccessor[] }>;
export function resolvePwaProvisioningRecovery(input: ResolvePwaProvisioningRecoveryInput): Promise<PwaProvisioningRecovery | undefined>;
export function discoverPwaProvisioningSuccessor(input: ResolvePwaProvisioningRecoveryInput): Promise<PwaProvisioningSuccessor | undefined>;
export function reconcilePwaProvisioningPending(input: ResolvePwaProvisioningRecoveryInput): Promise<LiveJournal>;
export function createLiveJournalStore(path: string, funder: Address): Readonly<{ load(): LiveJournal; save(journal: LiveJournal): void; close(): void }>;
export function resolveCompletedHistoricalPwaVault(input: Readonly<{ reviewDirectory: string; journal: LiveJournal; providers: readonly [HistoricalPwaReadClient, HistoricalPwaReadClient]; relay: Readonly<{ getTransactionCount(input: Readonly<{ address: Address; blockTag: "latest" | "pending" }>): Promise<number | bigint> }>; successors: readonly PwaProvisioningSuccessor[] }>): Promise<PwaHistoricalVault | undefined>;
export function resolvePwaProvisioningPlan(input: Readonly<{ profile: Readonly<Record<string, unknown>>; deployer: Address; expectedDeployerNonce: bigint; expectedCurrentDeployerNonce?: bigint; successorStartingNonce?: bigint; prerequisiteStartingNonce?: bigint; confirmedSuccessorTransactionCount?: 0 | 1 | 2 | 3 | 4 | 5 | 6; safeProxySaltNonce: bigint; primaryCredential: PwaCredentialCoordinates; secondaryCredential: PwaCredentialCoordinates; client: unknown; confirmedProvisioningPrefixLength?: number; verifiedDeploymentPrefixLength?: number }>): Promise<PwaProvisioningPlan>;
export function provisioningPackageHash(plan: PwaProvisioningPlan): Hex;
export function writePwaProvisioningReview(plan: PwaProvisioningPlan, outputDirectory: string): { packageHash: Hex; path: string };
export function executePwaProvisioning(plan: PwaProvisioningPlan, context: PwaProvisioningExecutionContext): Promise<PwaProvisioningResult>;
export function createPwaProvisioningRuntime(input: Readonly<{ plan: PwaProvisioningPlan; journalPath: string; account: unknown; client: unknown; authorize?(transaction: PwaProvisioningTransaction): Promise<ApprovedPwaProvisioningTransaction> }>): Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>;
export function brandPwaProvisioningExecutionContextForTestsOnly(context: PwaProvisioningExecutionContext): PwaProvisioningExecutionContext;

// Reviewed backend-only current-state and submission boundary.
type SubmissionDependency = Readonly<{ name: string; version: string; address: Address; runtimeCodeHash: Hex; evidence: "verified"; source: string; supportsModuleGuards?: boolean }>;
export type VerifiedDeploymentInfrastructure = Readonly<{
  chainId: number; deployer: Address; observedDeployerNonce: bigint;
  safeSingleton: SubmissionDependency; safeProxyFactory: SubmissionDependency; passkeySignerFactory: SubmissionDependency; passkeySignerVerifier: SubmissionDependency; multiSendCallOnly: SubmissionDependency;
  passkeySigner: Readonly<{ name: "passkeySigner"; address: Address; runtimeCodeHash: Hex; bindingHash: Hex; source: string }>;
  dependencies: Readonly<Record<"safeSingleton" | "safeProxyFactory" | "passkeySignerFactory" | "passkeySignerVerifier" | "multiSendCallOnly", SubmissionDependency>>;
}>;

export type PwaSubmissionReadClient = Readonly<{
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber: bigint }): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  getBytecode(args: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Address; slot: Hex; blockNumber?: bigint }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  getTransactionCount(args: { address: Address; blockNumber?: bigint }): Promise<number | bigint>;
}>;
export type TopologyReport = Readonly<{ ok: boolean; failures: readonly string[]; checked: readonly string[] }>;
export type PwaSubmissionState = Readonly<{ vault: PwaProvisioningResult; deployments: VerifiedDeploymentInfrastructure; policy: VaultPolicy; topologyReport: TopologyReport; topologyReportHash: Hex }>;
export function verifyPwaSubmissionState(input: Readonly<{ plan: PwaProvisioningPlan; vault: PwaProvisioningResult; client: PwaSubmissionReadClient; blockNumber: bigint }>): Promise<PwaSubmissionState>;
export function isVerifiedPwaProvisioningResult(value: unknown): value is PwaProvisioningResult;
export type VerifiedPwaQueueItem = PwaQueueBinding & Readonly<{ safe: Address; delay: Address }>;
export type VerifiedPwaSnapshot = Readonly<{
  formatVersion: 2; chainId: 11155111; blockNumber: bigint; blockHash: Hex; timestamp: bigint;
  deploymentsHash: Hex; policyHash: Hex; safe: Address; guard: Address; delay: Address; usdc: Address;
  baseRecipientMode: "any-valid-address"; elevatedRecipients: readonly [Address, ...Address[]]; primaryPasskey: Address; secondaryPasskey: Address;
  safeNonce: bigint; spendState: AssetSpendState;
  limits: Readonly<{ basePerTransaction: bigint; baseDailyLimit: bigint; stepUpPerTransaction: bigint; instantDailyLimit: bigint }>;
  cooldownSeconds: bigint; expirationSeconds: bigint; queueHeadNonce: bigint; queueTailNonce: bigint; queueHead: VerifiedPwaQueueItem | null;
}>;
export type PwaIntent = Readonly<{ kind: "transfer"; recipient: Address; amount: bigint }> | Readonly<{ kind: "add-recipient"; recipient: Address }> | Readonly<{ kind: "cancel-queued" | "execute-ready" | "skip-expired"; queueNonce: bigint; queueFingerprint: Hex }>;
export type PwaSnapshotReader = Readonly<{
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  readAt(blockNumber: bigint): Promise<Omit<VerifiedPwaSnapshot, "formatVersion" | "chainId" | "blockNumber" | "blockHash" | "timestamp">>;
}>;
export type PwaSimulationClient = Readonly<{
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null }>>;
  call(input: Readonly<{ account: Address; to: Address; value: bigint; data: Hex; blockNumber: bigint }>): Promise<Readonly<{ data?: Hex }>>;
}>;
export function captureVerifiedPwaSnapshot(vault: PwaProvisioningResult, blockNumber: bigint, reader: PwaSnapshotReader): Promise<VerifiedPwaSnapshot>;
export function preparePwaIntent(snapshot: VerifiedPwaSnapshot, intent: PwaIntent): PreparedPwaIntent;
export function assertSamePreparedPwaIntent(expected: PreparedPwaIntent, actual: unknown): void;
export function simulatePwaIntent(prepared: PreparedPwaIntent, client: PwaSimulationClient): Promise<SimulationEvidence>;
export function decodePwaRecipientRepair(data: Hex): Readonly<{ expectedPolicyHash: Hex; recipients: readonly Address[]; recipient: Address }>;
export type VerifiedContractApproval = Readonly<{ address: Address; payload: Hex }>;
export function encodeGuardContractSignatures(primary: VerifiedContractApproval, secondary?: VerifiedContractApproval): Hex;
export function canonicalSubmissionJson(value: unknown): string;
export function snapshotPreparedPwaIntent(value: unknown): PreparedPwaIntent;
export function snapshotSubmissionRequest(value: unknown): SubmissionRequest;
export function submissionRequestHash(request: SubmissionRequest): Hex;
export function deploymentInfrastructureHash(value: VerifiedDeploymentInfrastructure): Hex;
export function encodeSafeExecutionCalldata(request: SafeExecutionRequest): Hex;
export function encodeDelayExecutionCalldata(request: DelayExecutionRequest): Hex;
export function queueFingerprint(input: Readonly<{ safe: Address; delay: Address; to: Address; value: bigint; data: Hex; operation: 0; queueNonce: bigint }>): Hex;
export type CanonicalReceipt = Readonly<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: "success" | "reverted" }>;
export type RelayerContext = Readonly<{
  readers: Readonly<{
    chainId(): Promise<number>; deployments(): Promise<VerifiedDeploymentInfrastructure>; topology(safe: Address): Promise<Readonly<{ ok: boolean; failures: readonly string[]; checked: readonly string[] }>>;
    safeNonce(safe: Address): Promise<bigint>; policyHash(guard: Address): Promise<Hex>; spendState(guard: Address, asset: Address): Promise<AssetSpendState>;
    delayItem(delay: Address, nonce: bigint): Promise<Readonly<{ to: Address; value: bigint; data: Hex; operation: number; txHash: Hex; createdAt: bigint }>>;
    delayNonce(delay: Address): Promise<bigint>; blockTimestamp(): Promise<bigint>; receipt(hash: Hex): Promise<CanonicalReceipt | undefined>;
  }>;
  broadcaster: Readonly<{ executeSafe(target: Address, exactCalldata: Hex): Promise<Hex>; executeDelay(target: Address, exactCalldata: Hex): Promise<Hex> }>;
}>;
export function validateAndBroadcast(input: SubmissionRequest, context: RelayerContext): Promise<SubmissionResult>;
export type PwaObservedQueue = PwaQueueBinding & Readonly<{ safe: Address; delay: Address }>;
export type PwaObservedState = Readonly<{
  policy: VaultPolicy; safeNonce: bigint; queueHeadNonce: bigint; queueTailNonce: bigint; safeUsdcBalance: bigint; recipientUsdcBalance: bigint;
  spendState: AssetSpendState; queueHead: PwaObservedQueue | null; deploymentsHash: Hex; policyHash: Hex; topologyReportHash: Hex;
}>;
export type PwaObserverLog = Readonly<{ address: Address; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: number; topics: readonly Hex[]; data: Hex; removed?: boolean }>;
export type PwaObserverReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex; logs: readonly PwaObserverLog[] }>;
export type PwaObserverTransaction = Readonly<{ hash: Hex; to: Address | null; value: bigint; input: Hex }>;
export type PwaObserverClient = Readonly<{
  source: string; getBlockNumber(): Promise<bigint>; getTransactionReceipt(input: Readonly<{ hash: Hex }>): Promise<PwaObserverReceipt | null>;
  getTransaction(input: Readonly<{ hash: Hex }>): Promise<PwaObserverTransaction | null>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  readStateAt(blockNumber: bigint): Promise<PwaObservedState>;
}>;
export type PwaObserverIdentity = Readonly<{ processId: string; executableHash: Hex; startedAt: string }>;
export type PwaObserverBinding = Readonly<{ intent: PreparedPwaIntent; profileHash: Hex; topologyReportHash: Hex; confirmations: number; observer: PwaObserverIdentity; clients: readonly [PwaObserverClient, PwaObserverClient] }>;
export type PwaObserverRecord = Readonly<{
  formatVersion: 1; scope: "sepolia-pwa-receipt-observation"; kind: PreparedPwaIntent["kind"]; chainId: 11155111; transactionHash: Hex;
  blockNumber: string; blockHash: Hex; confirmations: number; safe: Address; guard: Address; delay: Address; usdc: Address; amount: string;
  profileHash: Hex; deploymentsHash: Hex; policyHash: Hex; topologyReportHash: Hex; outerEnvelopeHash: Hex; beforeStateHash: Hex; afterStateHash: Hex;
  observer: PwaObserverIdentity; sources: readonly [string, string]; notificationDelivery: "not-claimed"; observedAt: string; recordHash: Hex;
}>;
export function observePwaReceipt(binding: PwaObserverBinding, receiptHash: Hex): Promise<PwaObserverRecord>;
export function serializePwaObserverRecord(record: PwaObserverRecord): string;

export type AssetPolicy = Readonly<{
  token: Address;
  basePerTransaction: bigint;
  stepUpPerTransaction: bigint;
  baseDailyLimit: bigint;
  instantDailyLimit: bigint;
  baseRecipientMode: "allowlisted" | "any-valid-address";
  recipients: readonly Address[];
}>;

export type SignerRole = "primary" | "secondary";
export type SignerKind = "safe-contract" | "ecdsa-extension";
export type SecondaryProfile = "dual" | "contract-only";

export type ConfiguredSigner = Readonly<{
  address: Address;
  role: SignerRole;
  kind: SignerKind;
  enabled: boolean;
}>;

export type VaultPolicy = Readonly<{
  chainId: number;
  safe: Address;
  primary?: Address;
  secondaries?: readonly ConfiguredSigner[];
  secondaryProfile?: SecondaryProfile;
  /** @deprecated use primary */
  passkey: Address;
  /** @deprecated use secondaries */
  ecdsaSecondary: Address;
  delay: Address;
  periodSeconds: 86400;
  periodAnchor: bigint;
  cooldownSeconds: number;
  expirationSeconds: number;
  assets: readonly AssetPolicy[];
}>;

export type AssetSpendState = Readonly<{
  window: bigint;
  baseSpent: bigint;
  instantSpent: bigint;
}>;


export type SafeTxMessage = Readonly<{
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}>;



export type SafeExecutionRequest = Readonly<{
  version: 1;
  kind: "safe-execution";
  idempotencyKey: Hex;
  chainId: number;
  deploymentsHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  asset: Address;
  transaction: SafeTxMessage;
  safeTxHash: Hex;
  signatures: Hex;
  expectedSpend: AssetSpendState;
}>;

export type DelayExecutionRequest = Readonly<{
  version: 1;
  kind: "delay-execution";
  idempotencyKey: Hex;
  chainId: number;
  deploymentsHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  queueNonce: bigint;
  queueFingerprint: Hex;
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0;
  createdAt: bigint;
  cooldownSeconds: bigint;
  expirationSeconds: bigint;
}>;

export type SubmissionRequest = SafeExecutionRequest | DelayExecutionRequest;

export type SubmissionResult =
  | { kind: "submitted"; requestHash: Hex; transactionHash: Hex }
  | { kind: "confirmed"; requestHash: Hex; transactionHash: Hex; blockNumber: bigint; blockHash: Hex }
  | { kind: "reverted" | "stale" | "unsupported-chain" | "rpc-inconsistent" | "transport-unavailable"; requestHash: Hex; reason: string };

export type SubmissionTransport = Readonly<{
  submit(request: SubmissionRequest): Promise<SubmissionResult>;
}>;

export type PwaQueueBinding = Readonly<{
  queueNonce: bigint;
  queueFingerprint: Hex;
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0;
  createdAt: bigint;
  readyAt: bigint;
  expiresAt: bigint;
}>;

export type PreparedSignedPwaIntent = Readonly<{
  version: 1;
  kind: "base-transfer" | "step-up-transfer" | "queue-transfer" | "add-recipient" | "cancel-queued";
  snapshotHash: Hex;
  chainId: 11155111;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  deploymentsHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  asset: Address;
  recipient: Address;
  amount: bigint;
  expectedSpend: AssetSpendState;
  queue: PwaQueueBinding | null;
  requiredApprovals: readonly ["primary"] | readonly ["primary", "secondary"];
  safeTx: SafeTxMessage;
  safeTxHash: Hex;
}>;

export type PreparedDirectPwaIntent = Readonly<{
  version: 1;
  kind: "execute-ready" | "skip-expired";
  snapshotHash: Hex;
  chainId: 11155111;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  deploymentsHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  asset: Address;
  recipient: Address;
  amount: bigint;
  queue: PwaQueueBinding;
  requiredApprovals: readonly [];
  call: Readonly<{ to: Address; value: 0n; data: Hex; operation: 0 }>;
}>;

export type PreparedPwaIntent = PreparedSignedPwaIntent | PreparedDirectPwaIntent;

export type SimulationEvidence = Readonly<{
  ok: boolean;
  blockNumber: bigint;
  blockHash: Hex;
  callHash: Hex;
  returnData?: Hex;
  reason?: string;
}>;
export type PwaProvisioningEnvelopePolicy = Readonly<{
  gasMarginBps: bigint;
  feeMarginBps: bigint;
  maxEstimateDivergenceBps: bigint;
  maxTotalOutlayWei: bigint;
}>;

export type PwaProvisioningEnvelopeInput = Readonly<{
  estimates: readonly [bigint, bigint];
  blockGasLimit: bigint;
  baseFeePerGas: bigint;
  priorityFeesPerGas: readonly [bigint, bigint];
  value: bigint;
  confirmedActualCost: bigint;
  pendingReservation: bigint;
  relayBalance: bigint;
  policy: PwaProvisioningEnvelopePolicy;
}>;

export type PwaProvisioningEnvelope = Readonly<{
  gasEstimate: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  reservation: bigint;
  totalOutlay: bigint;
  requiredBalance: bigint;
}>;


export function derivePwaProvisioningEnvelope(input: PwaProvisioningEnvelopeInput): PwaProvisioningEnvelope;
