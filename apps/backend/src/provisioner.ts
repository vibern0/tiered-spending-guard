import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as pwaNamespace from "@recent-tx-safe-guard/security-core/pwa";
import type {
  PwaProvisioningExecutionContext,
  PwaProvisioningPlan,
  PwaProvisioningQuoteClient,
  PwaProvisioningRecovery,
  PwaProvisioningRecoveryClient,
  PwaProvisioningResult,
  PwaProvisioningTransaction,
  PwaHistoricalVault,
  HistoricalPwaReadClient,
} from "@recent-tx-safe-guard/security-core/pwa";
import type { StoredCredential } from "./webauthn";
import type { BackendConfig } from "./config";
import { recoverAutomaticPwaProvisioning } from "./automatic-recovery";
import { batchedReadTransport } from "./batched-read-transport";
import { loadEvidenceAccess } from "./evidence-access";

// Hardhat keeps security-core CommonJS; Node ESM exposes it under default while Vitest exposes named exports.
const pwaRuntime = (pwaNamespace as unknown as { default?: typeof pwaNamespace }).default ?? pwaNamespace;

const {
  assertPwaProvisioningTransactionAuthorization,
  collectPwaProvisioningQuote,
  createLocalPhaseOneProvisioningAuthorizer,
  createPwaProvisioningAuthorizationStore,
  createPwaProvisioningRuntime,
  executePwaProvisioning,
  loadCommittedPwaPhaseOneProfile,
  loadCommittedPwaProvisioningAutomationPolicy,
  loadCommittedPwaProvisioningSuccessors,
  provisioningPackageHash,
  readLiveJournal,
  resolvePwaProvisioningPlan,
  resolvePwaProvisioningRecovery,
  resolveCompletedHistoricalPwaVault,
  writePwaProvisioningReview,
} = pwaRuntime;

export type BackendPwaProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  evidence: Readonly<{ setupTransactionHash: Hex; verificationReportHash: Hex; deploymentsHash: Hex; policyHash: Hex }>;
}>;

export type BackendPwaProvisioningCompletion = Readonly<{
  response: BackendPwaProvisioningResult;
  verified: PwaProvisioningResult;
  plan?: PwaProvisioningPlan;
}>;

export type ProvisioningCredentials = Readonly<{ primary: StoredCredential; secondary: StoredCredential }>;

export type AutomaticPwaRecoveryPreflight = Readonly<{
  confirmedPrefixLength: number;
  nextTransactionId: PwaProvisioningTransaction["id"];
  nextTransactionNonce: string;
  packageHash: Hex;
  planHash: Hex;
  quoteBlockNumber: string;
  quoteBlockHash: Hex;
  gasEstimateA: string;
  gasEstimateB: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  confirmedActualCost: string;
  resultingOutlayWei: string;
  relayBalance: string;
}>;

export type AutomaticPwaProvisioner = Readonly<{
  historicalVault?: PwaHistoricalVault;
  completedRecoveryReady?: boolean;
  recoveryCredentials?: PwaProvisioningRecovery["credentials"];
  preflight?(): Promise<AutomaticPwaRecoveryPreflight>;
  provision(input?: ProvisioningCredentials): Promise<BackendPwaProvisioningCompletion>;
}>;

export type AutomaticPwaProvisionerOptions = Readonly<{
  historicalVault?: PwaHistoricalVault;
  reviewDirectory: string;
  recovery?: PwaProvisioningRecovery;
  reloadRecovery?(): Promise<PwaProvisioningRecovery | undefined>;
  createPlan(input: ProvisioningCredentials): Promise<PwaProvisioningPlan>;
  executionContext(plan: PwaProvisioningPlan): Promise<Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>> | Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>;
  preflight?(): Promise<AutomaticPwaRecoveryPreflight>;
}>;

/** Keeps authorization evidence bound to one immutable reviewed package lineage. */
export function pwaProvisioningAuthorizationPath(journalPath: string, packageHash: Hex): string {
  return `${journalPath}.authorizations.${packageHash.slice(2)}.json`;
}

function result(value: PwaProvisioningResult): BackendPwaProvisioningResult {
  return Object.freeze({
    chainId: value.chainId,
    safe: value.safe,
    guard: value.guard,
    delay: value.delay,
    primaryPasskey: value.primaryPasskey,
    secondaryPasskey: value.secondaryPasskey,
    usdc: value.usdc,
    evidence: Object.freeze({ setupTransactionHash: value.setupReceipt.transactionHash, verificationReportHash: value.topologyReportHash, deploymentsHash: value.deploymentsHash, policyHash: value.policyHash }),
  });
}

function credentialIdentity(input: ProvisioningCredentials): string {
  const encode = (credential: StoredCredential) => JSON.stringify([
    credential.role,
    credential.id,
    credential.x.toString(),
    credential.y.toString(),
    Buffer.from(credential.publicKey).toString("base64url"),
  ]);
  return `${encode(input.primary)}:${encode(input.secondary)}`;
}

function recoverableProvisioningFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /Sepolia RPC request failed|submission outcome unknown|provisioning (?:quote|relay) nonce mismatch|nonce drift before provisioning|deployer nonce does not equal/.test(message)
    && !/ExecutionRevertedError|ContractFunctionRevertedError/.test(message);
}

/** One backend-trusted, single-flight Sepolia provisioning operation. */
export function createAutomaticPwaProvisioner(options: AutomaticPwaProvisionerOptions): AutomaticPwaProvisioner {
  if (options.historicalVault) return historicalProvisioner(options.historicalVault);
  let boundCredentialIdentity: string | undefined;
  let preparedPlan = options.recovery?.plan;
  let recovered = options.recovery;
  let inFlight: Promise<BackendPwaProvisioningCompletion> | undefined;
  let completed: BackendPwaProvisioningCompletion | undefined;

  const provision = (credentials?: ProvisioningCredentials): Promise<BackendPwaProvisioningCompletion> => {
    if (!preparedPlan && !credentials && !options.reloadRecovery) return Promise.reject(new Error("verified primary and secondary credentials are required for fresh provisioning"));
    if (!options.recovery && credentials) {
      const identity = credentialIdentity(credentials);
      if (boundCredentialIdentity !== undefined && identity !== boundCredentialIdentity) return Promise.reject(new Error("automatic provisioning is already bound to a different credential pair"));
      boundCredentialIdentity = identity;
    }
    if (completed) return Promise.resolve(completed);
    if (inFlight) return inFlight;

    const executeOnce = async () => {
      if (options.reloadRecovery) {
        recovered = await options.reloadRecovery();
        preparedPlan = recovered?.plan;
      }
      if (!preparedPlan && !credentials) throw new Error("verified primary and secondary credentials are required for fresh provisioning");
      if (!preparedPlan) preparedPlan = await options.createPlan(credentials!);
      const plan = preparedPlan;
      if (plan.chainId !== sepolia.id) throw new Error("automatic provisioning supports only Ethereum Sepolia");
      const review = writePwaProvisioningReview(plan, options.reviewDirectory);
      if (provisioningPackageHash(plan) !== review.packageHash) throw new Error("automatic provisioning review package changed before execution");
      const lease = await options.executionContext(plan);
      try {
        const verified = await executePwaProvisioning(plan, lease.context);
        completed = Object.freeze({ response: result(verified), verified, plan });
        return completed;
      } finally {
        lease.close();
      }
    };
    const operation = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await executeOnce(); }
        catch (error) {
          if (!options.reloadRecovery || !recoverableProvisioningFailure(error) || attempt >= 2) throw error;
          // Reconstruct and verify recorded progress before another attempt.
          // A durable hash is reconciled, never signed or broadcast again.
          await new Promise<void>(resolve => setTimeout(resolve, 500));
        }
      }
    })();
    inFlight = operation;
    void operation.finally(() => { if (!completed) inFlight = undefined; }).catch(() => undefined);
    return operation;
  };

  const preflight = options.preflight ?? (() => Promise.reject(new Error("recovery preflight is unavailable for fresh provisioning")));
  return Object.freeze({ preflight, provision, get recoveryCredentials() { return recovered?.credentials; }, get completedRecoveryReady() { return recovered?.confirmedPrefixLength === 7; } });
}

function historicalProvisioner(historicalVault: PwaHistoricalVault): AutomaticPwaProvisioner {
  const unavailable = () => Promise.reject(new Error("historical vault is read-only; current-profile provisioning and transfers are disabled"));
  return Object.freeze({ historicalVault, recoveryCredentials: historicalVault.credentials, provision: unavailable, preflight: unavailable });
}

type PublicClient = ReturnType<typeof createPublicClient>;

const RPC_READ_METHODS = new Set(["getChainId", "getBlockNumber", "getBlock", "getTransactionCount", "estimateGas", "estimateMaxPriorityFeePerGas", "getCode", "getStorageAt", "call", "getTransaction", "getTransactionReceipt", "getBalance", "estimateFeesPerGas", "waitForTransactionReceipt"]);

function rpcCauses(error: unknown): readonly Error[] {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && seen.size < 6 && !seen.has(current)) {
    seen.add(current);
    current = current.cause;
  }
  return [...seen];
}

export async function sanitizeRpc<T>(label: string, method: string, operation: () => Promise<T>, retryReadNotFound = false): Promise<T> {
  let failure: unknown;
  try {
    return await operation();
  } catch (error) {
    failure = error;
  }
  const readOnly = RPC_READ_METHODS.has(method) || /^readContract:[A-Za-z][A-Za-z0-9_]*$/.test(method);
  for (let retry = 0; retryReadNotFound && readOnly; retry++) {
    const causes = rpcCauses(failure);
    const reverted = causes.some(cause => /^(ExecutionRevertedError|ContractFunctionRevertedError)$/.test(cause.name));
    const missingHistoricalState = method === "getTransactionCount" && causes.some(cause =>
      /^(InvalidInputRpcError|RpcRequestError)$/.test(cause.name)
      && (cause as Error & { code?: unknown }).code === -32000
      && /historical state [0-9a-f]{64} is not available/i.test(cause.message));
    const limit = missingHistoricalState ? 3 : causes.some(cause => cause.name === "ResourceNotFoundRpcError") ? 1 : 0;
    if (reverted || retry >= limit) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    try { return await operation(); }
    catch (error) { failure = error; }
  }
  const category = rpcCauses(failure).map(cause => {
    const name = cause.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "Error";
    const code = (cause as Error & { code?: unknown }).code;
    return `${name}${typeof code === "number" && Number.isSafeInteger(code) ? `:${code}` : ""}`;
  }).join(" > ") || "UnknownError";
  throw new Error(`${label} Sepolia RPC request failed (${method}; ${category})`);
}

function recoveryTransaction(transaction: Awaited<ReturnType<PublicClient["getTransaction"]>>) {
  if (transaction.type !== "eip1559" || transaction.chainId === undefined || transaction.maxFeePerGas === undefined || transaction.maxPriorityFeePerGas === undefined) throw new Error("non-EIP-1559 transaction");
  return { hash: transaction.hash, chainId: transaction.chainId, type: "eip1559" as const, from: transaction.from, to: transaction.to, nonce: transaction.nonce, value: transaction.value, input: transaction.input, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas };
}

export function createReadClient(url: string, label: string, options: Readonly<{ batch?: boolean; fetchFn?: typeof fetch; source?: string }> = {}): Omit<HistoricalPwaReadClient & PwaProvisioningQuoteClient & PwaProvisioningRecoveryClient, "getBlock"> & Readonly<{ getBlock(input: { blockNumber: bigint }): Promise<{ number: bigint; hash: Hex | null; timestamp: bigint; baseFeePerGas: bigint | null; gasLimit: bigint }> }> {
  const client = createPublicClient({ chain: sepolia, transport: options.batch ? batchedReadTransport(url, options.fetchFn) : http(url) }) as PublicClient;
  const read = <T>(method: string, operation: () => Promise<T>) => sanitizeRpc(label, method, operation, true);
  return Object.freeze({
    source: options.source ?? url,
    getChainId: () => read("getChainId", () => client.getChainId()),
    getBlockNumber: () => read("getBlockNumber", () => client.getBlockNumber()),
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => read("getBlock", async () => {
      const block = await client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas, gasLimit: block.gasLimit };
    }),
    getBlockWithTransactions: ({ blockNumber }: { blockNumber: bigint }) => read("getBlock", async () => {
      const block = await client.getBlock({ blockNumber, includeTransactions: true });
      return { number: block.number, hash: block.hash, transactions: block.transactions.filter(transaction => transaction.type === "eip1559").map(recoveryTransaction) };
    }),
    getTransactionCount: ({ address, blockNumber, blockTag }: { address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }) => read("getTransactionCount", () => client.getTransactionCount({ address, ...(blockNumber === undefined ? { blockTag: blockTag ?? "latest" } : { blockNumber }) })),
    estimateGas: ({ account, to, data, value, blockNumber }: { account: Address; to?: Address; data: Hex; value: bigint; blockNumber: bigint }) => read("estimateGas", () => client.estimateGas({ account, ...(to ? { to } : {}), data, value, blockNumber })),
    getMaxPriorityFeePerGas: () => read("estimateMaxPriorityFeePerGas", () => client.estimateMaxPriorityFeePerGas()),
    getBytecode: ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => read("getCode", () => client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) })),
    getStorageAt: (args: { address: Address; slot: Hex; blockNumber?: bigint }) => read("getStorageAt", () => client.getStorageAt(args)),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => read(`readContract:${args.functionName}`, () => client.readContract(args as never)),
    call: ({ data }: { data: Hex }) => read("call", () => client.call({ data })),
    getTransaction: ({ hash }: { hash: Hex }) => read("getTransaction", async () => {
      try { return recoveryTransaction(await client.getTransaction({ hash })); }
      catch (error) { if (error instanceof Error && error.name === "TransactionNotFoundError") return null; throw error; }
    }),
    getTransactionReceipt: ({ hash }: { hash: Hex }) => read("getTransactionReceipt", async () => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
      } catch (error) { if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null; throw error; }
    }),
  });
}

export function createRelayClient(url: string) {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(url) });
  const read = <T>(method: string, operation: () => Promise<T>) => sanitizeRpc("relay", method, operation, true);
  return {
    getBytecode: ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => read("getCode", () => publicClient.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) })),
    getTransactionCount: ({ address, blockNumber, blockTag }: { address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }) => read("getTransactionCount", () => publicClient.getTransactionCount({ address, ...(blockNumber === undefined ? { blockTag: blockTag ?? "latest" } : { blockNumber }) })),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => read(`readContract:${args.functionName}`, () => publicClient.readContract(args as never)),
    call: (args: { data: Hex }) => read("call", () => publicClient.call(args)),
    getStorageAt: (args: { address: Address; slot: Hex; blockNumber?: bigint }) => read("getStorageAt", () => publicClient.getStorageAt(args)),
    getChainId: () => read("getChainId", () => publicClient.getChainId()),
    getBalance: ({ address }: { address: Address }) => read("getBalance", () => publicClient.getBalance({ address })),
    sendRawTransaction: ({ serializedTransaction }: { serializedTransaction: Hex }) => sanitizeRpc("relay", "sendRawTransaction", () => publicClient.sendRawTransaction({ serializedTransaction })),
    estimateGas: (args: { account: Address; to?: Address; data: Hex; value: bigint }) => read("estimateGas", () => publicClient.estimateGas(args)),
    estimateFeesPerGas: async () => read("estimateFeesPerGas", async () => {
      const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new Error("fees unavailable");
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    }),
    getBlockNumber: () => read("getBlockNumber", () => publicClient.getBlockNumber()),
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => read("getBlock", async () => {
      const block = await publicClient.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas, gasLimit: block.gasLimit };
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => read("getTransactionReceipt", async () => {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    }),
    waitForTransactionReceipt: async ({ hash, confirmations }: { hash: Hex; confirmations: number }) => read("waitForTransactionReceipt", async () => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
      return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    }),
  };
}

type AutomaticDependencies = Readonly<{ providers: readonly [ReturnType<typeof createReadClient>, ReturnType<typeof createReadClient>]; relay: Omit<ReturnType<typeof createRelayClient>, "getTransactionCount" | "getBlock"> & Pick<ReturnType<typeof createReadClient>, "getTransactionCount" | "getBlock"> }>;

/** Concrete local Sepolia composition. Phase One authorization is not independent. */
export function createConfiguredAutomaticPwaProvisioner(config: BackendConfig): Promise<AutomaticPwaProvisioner> {
  const access = loadEvidenceAccess(config.evidenceConfigPath);
  return composeAutomaticPwaProvisioner(config, { providers: [
    createReadClient(access.urls[0], access.operators[0], { batch: true, source: access.operators[0] }),
    createReadClient(access.urls[1], access.operators[1], { batch: true, source: access.operators[1] }),
  ], relay: createRelayClient(config.rpcUrl) });
}

export function createConfiguredAutomaticPwaProvisionerForTestsOnly(config: BackendConfig, dependencies: AutomaticDependencies): Promise<AutomaticPwaProvisioner> {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only automatic provisioning dependencies are disabled");
  return composeAutomaticPwaProvisioner(config, dependencies);
}

async function composeAutomaticPwaProvisioner(config: BackendConfig, { providers, relay }: AutomaticDependencies): Promise<AutomaticPwaProvisioner> {
  if (config.id !== "local") throw new Error("automatic PWA provisioning is available only for BACKEND_PROFILE=local");
  const profile = loadCommittedPwaPhaseOneProfile();
  const policy = loadCommittedPwaProvisioningAutomationPolicy();
  const authorizer = createLocalPhaseOneProvisioningAuthorizer(policy);
  const account = privateKeyToAccount(config.relayPrivateKey);
  let recovery: PwaProvisioningRecovery | undefined;
  const recover = (waitForPending = false) => recoverAutomaticPwaProvisioning({ config, deployer: account.address, profile, safeProxySaltNonce: policy.safeProxySaltNonce, providers, relay, waitForPending });
  try {
    let restored: Awaited<ReturnType<typeof recover>> | undefined;
    for (let attempt = 0; ; attempt++) {
      try { restored = await recover(); break; }
      catch (error) {
        if (!recoverableProvisioningFailure(error) || attempt >= 2) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 500));
      }
    }
    if (restored.historicalVault) return historicalProvisioner(restored.historicalVault);
    recovery = restored.recovery;
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith("fail closed: PWA provisioning recovery ") ? `: ${error.message}` : "";
    throw new Error(`automatic provisioning recovery validation failed closed${detail}`);
  }

  const assertRelayQuoteAnchor = async (plan: PwaProvisioningPlan, transaction: PwaProvisioningTransaction, quote: Awaited<ReturnType<typeof collectPwaProvisioningQuote>>) => {
    const [block, latest, pending] = await Promise.all([
      relay.getBlock({ blockNumber: quote.blockNumber }),
      relay.getTransactionCount({ address: plan.deployer, blockTag: "latest" }),
      relay.getTransactionCount({ address: plan.deployer, blockTag: "pending" }),
    ]);
    if (block.number !== quote.blockNumber || block.hash?.toLowerCase() !== quote.blockHash.toLowerCase()) throw new Error("fail closed: relay quote block changed before provisioning authorization");
    if (BigInt(latest) !== transaction.nonce || BigInt(pending) !== transaction.nonce) throw new Error("fail closed: relay latest/pending nonce changed before provisioning authorization");
  };

  const authorizeNext = async (plan: PwaProvisioningPlan, transaction: PwaProvisioningTransaction) => {
    const quote = await collectPwaProvisioningQuote({ transaction, deployer: plan.deployer, providers, relay, policy });
    const journal = readLiveJournal(config.provisioningJournalPath, plan.deployer);
    const confirmedActualCost = journal.entries.filter((entry: { status: string }) => entry.status === "success").reduce((total: bigint, entry: { reserved: bigint }) => total + entry.reserved, 0n);
    const pendingReservation = journal.entries.filter((entry: { status: string }) => entry.status === "pending").reduce((total: bigint, entry: { reserved: bigint }) => total + entry.reserved, 0n);
    const relayBalance = await relay.getBalance({ address: plan.deployer });
    await assertRelayQuoteAnchor(plan, transaction, quote);
    const authorization = await authorizer.authorizeTransaction(plan, transaction, quote, {
      chainId: plan.chainId,
      deployer: plan.deployer,
      deployerNonce: transaction.nonce,
      packageHash: provisioningPackageHash(plan),
      planHash: plan.planHash,
      confirmedActualCost,
      pendingReservation,
      relayBalance,
      authorizedAt: new Date().toISOString(),
    });
    return Object.freeze({ quote, authorization, confirmedActualCost, relayBalance });
  };

  return createAutomaticPwaProvisioner({
    reviewDirectory: config.provisioningReviewDirectory,
    recovery,
    async reloadRecovery() {
      const restored = await recover(true);
      if (restored.pending) throw new Error("automatic provisioning is still awaiting canonical confirmations for its recorded transaction");
      if (restored.historicalVault) throw new Error("historical vault is read-only");
      recovery = restored.recovery;
      return recovery;
    },
    async preflight() {
      if (!recovery) throw new Error("recovery preflight requires a confirmed provisioning prefix");
      const transaction = recovery.plan.transactions[recovery.confirmedPrefixLength];
      if (!transaction) throw new Error("recovery has no missing provisioning transaction");
      const facts = await authorizeNext(recovery.plan, transaction);
      return Object.freeze({
        confirmedPrefixLength: recovery.confirmedPrefixLength,
        nextTransactionId: transaction.id,
        nextTransactionNonce: transaction.nonce.toString(),
        packageHash: provisioningPackageHash(recovery.plan),
        planHash: recovery.plan.planHash,
        quoteBlockNumber: facts.quote.blockNumber.toString(),
        quoteBlockHash: facts.quote.blockHash,
        gasEstimateA: facts.quote.estimates[0].toString(),
        gasEstimateB: facts.quote.estimates[1].toString(),
        gasLimit: facts.authorization.gasLimit,
        maxFeePerGas: facts.authorization.maxFeePerGas,
        maxPriorityFeePerGas: facts.authorization.maxPriorityFeePerGas,
        confirmedActualCost: facts.confirmedActualCost.toString(),
        resultingOutlayWei: facts.authorization.resultingOutlayWei,
        relayBalance: facts.relayBalance.toString(),
      });
    },
    async createPlan({ primary, secondary }) {
      const expectedDeployerNonce = BigInt(await relay.getTransactionCount({ address: account.address, blockTag: "latest" }));
      return resolvePwaProvisioningPlan({ profile, deployer: account.address, expectedDeployerNonce, safeProxySaltNonce: policy.safeProxySaltNonce, primaryCredential: { x: primary.x, y: primary.y }, secondaryCredential: { x: secondary.x, y: secondary.y }, client: relay });
    },
    executionContext(plan) {
      const packageHash = provisioningPackageHash(plan);
      let authorizationStore: ReturnType<typeof createPwaProvisioningAuthorizationStore> | undefined;
      try {
        const runtime = createPwaProvisioningRuntime({
          plan,
          journalPath: config.provisioningJournalPath,
          account,
          client: relay,
          async authorize(transaction: PwaProvisioningTransaction) {
            // Completed restoration never opens an authorization writer. Acquire
            // only when the exact missing deployment transaction needs approval.
            authorizationStore ??= createPwaProvisioningAuthorizationStore(pwaProvisioningAuthorizationPath(config.provisioningJournalPath, packageHash), { chainId: sepolia.id, deployer: plan.deployer, packageHash, planHash: plan.planHash });
            const facts = await authorizeNext(plan, transaction);
            const verified = assertPwaProvisioningTransactionAuthorization(plan, facts.authorization);
            authorizationStore.append(verified);
            await assertRelayQuoteAnchor(plan, transaction, facts.quote);
            return Object.freeze({ ...transaction, gasLimit: BigInt(verified.gasLimit), maxFeePerGas: BigInt(verified.maxFeePerGas), maxPriorityFeePerGas: BigInt(verified.maxPriorityFeePerGas) });
          },
        });
        return Object.freeze({ context: runtime.context, close: () => { try { runtime.close(); } finally { authorizationStore?.close(); } } });
      } catch (error) {
        authorizationStore?.close();
        throw error;
      }
    },
  });
}
