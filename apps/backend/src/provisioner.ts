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
} from "@recent-tx-safe-guard/security-core/pwa";
import type { StoredCredential } from "./webauthn";
import type { BackendConfig } from "./config";

// Hardhat keeps security-core CommonJS; Node ESM exposes it under default while Vitest exposes named exports.
const pwaRuntime = (pwaNamespace as unknown as { default?: typeof pwaNamespace }).default ?? pwaNamespace;

const {
  PWA_IDENTITY_PROVIDERS,
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
  recoveryCredentials?: PwaProvisioningRecovery["credentials"];
  preflight?(): Promise<AutomaticPwaRecoveryPreflight>;
  provision(input?: ProvisioningCredentials): Promise<BackendPwaProvisioningCompletion>;
}>;

export type AutomaticPwaProvisionerOptions = Readonly<{
  reviewDirectory: string;
  recovery?: PwaProvisioningRecovery;
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

/** One backend-trusted, single-flight Sepolia provisioning operation. */
export function createAutomaticPwaProvisioner(options: AutomaticPwaProvisionerOptions): AutomaticPwaProvisioner {
  let boundCredentialIdentity: string | undefined;
  let preparedPlan = options.recovery?.plan;
  let inFlight: Promise<BackendPwaProvisioningCompletion> | undefined;
  let completed: BackendPwaProvisioningCompletion | undefined;

  const provision = (credentials?: ProvisioningCredentials): Promise<BackendPwaProvisioningCompletion> => {
    if (!preparedPlan && !credentials) return Promise.reject(new Error("verified primary and secondary credentials are required for fresh provisioning"));
    if (!options.recovery && credentials) {
      const identity = credentialIdentity(credentials);
      if (boundCredentialIdentity !== undefined && identity !== boundCredentialIdentity) return Promise.reject(new Error("automatic provisioning is already bound to a different credential pair"));
      boundCredentialIdentity = identity;
    }
    if (completed) return Promise.resolve(completed);
    if (inFlight) return inFlight;

    const operation = (async () => {
      if (!preparedPlan) preparedPlan = await options.createPlan(credentials!);
      const plan = preparedPlan;
      if (plan.chainId !== sepolia.id) throw new Error("automatic provisioning supports only Ethereum Sepolia");
      const review = writePwaProvisioningReview(plan, options.reviewDirectory);
      if (provisioningPackageHash(plan) !== review.packageHash) throw new Error("automatic provisioning review package changed before execution");
      const lease = await options.executionContext(plan);
      try {
        const verified = await executePwaProvisioning(plan, lease.context);
        completed = Object.freeze({ response: result(verified), verified });
        return completed;
      } finally {
        lease.close();
      }
    })();
    inFlight = operation;
    void operation.finally(() => { if (!completed) inFlight = undefined; }).catch(() => undefined);
    return operation;
  };

  const preflight = options.preflight ?? (() => Promise.reject(new Error("recovery preflight is unavailable for fresh provisioning")));
  return Object.freeze({ preflight, provision, ...(options.recovery ? { recoveryCredentials: options.recovery.credentials } : {}) });
}

type PublicClient = ReturnType<typeof createPublicClient>;

async function sanitizeRpc<T>(label: string, method: string, operation: () => Promise<T>, retryReadNotFound = false): Promise<T> {
  let failure: unknown;
  try {
    return await operation();
  } catch (error) {
    failure = error;
  }
  if (retryReadNotFound && failure instanceof Error && failure.name === "ResourceNotFoundRpcError") {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    try {
      return await operation();
    } catch (error) {
      failure = error;
    }
  }
  const category = failure instanceof Error ? failure.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "Error" : "UnknownError";
  throw new Error(`${label} Sepolia RPC request failed (${method}; ${category})`);
}

function createReadClient(url: string, label: string): PwaProvisioningRecoveryClient & PwaProvisioningQuoteClient {
  const client = createPublicClient({ chain: sepolia, transport: http(url) }) as PublicClient;
  const read = <T>(method: string, operation: () => Promise<T>) => sanitizeRpc(label, method, operation, true);
  return Object.freeze({
    source: url,
    getChainId: () => read("getChainId", () => client.getChainId()),
    getBlockNumber: () => read("getBlockNumber", () => client.getBlockNumber()),
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => read("getBlock", async () => {
      const block = await client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash, baseFeePerGas: block.baseFeePerGas, gasLimit: block.gasLimit };
    }),
    getTransactionCount: ({ address, blockNumber, blockTag }: { address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }) => read("getTransactionCount", () => client.getTransactionCount({ address, ...(blockNumber === undefined ? { blockTag: blockTag ?? "latest" } : { blockNumber }) })),
    estimateGas: ({ account, to, data, value, blockNumber }: { account: Address; to?: Address; data: Hex; value: bigint; blockNumber: bigint }) => read("estimateGas", () => client.estimateGas({ account, ...(to ? { to } : {}), data, value, blockNumber })),
    getMaxPriorityFeePerGas: () => read("estimateMaxPriorityFeePerGas", () => client.estimateMaxPriorityFeePerGas()),
    getBytecode: ({ address }: { address: Address }) => read("getCode", () => client.getCode({ address })),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => read(`readContract:${args.functionName}`, () => client.readContract(args as never)),
    call: ({ data }: { data: Hex }) => read("call", () => client.call({ data })),
    getTransaction: ({ hash }: { hash: Hex }) => read("getTransaction", async () => {
      const transaction = await client.getTransaction({ hash });
      if (transaction.type !== "eip1559" || transaction.chainId === undefined || transaction.maxFeePerGas === undefined || transaction.maxPriorityFeePerGas === undefined) throw new Error("non-EIP-1559 transaction");
      return { hash: transaction.hash, chainId: transaction.chainId, type: "eip1559" as const, from: transaction.from, to: transaction.to, nonce: transaction.nonce, value: transaction.value, input: transaction.input, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas };
    }),
    getTransactionReceipt: ({ hash }: { hash: Hex }) => read("getTransactionReceipt", async () => {
      const receipt = await client.getTransactionReceipt({ hash });
      return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    }),
  });
}

function createRelayClient(url: string) {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(url) });
  const read = <T>(method: string, operation: () => Promise<T>) => sanitizeRpc("relay", method, operation, true);
  return {
    getBytecode: ({ address }: { address: Address }) => read("getCode", () => publicClient.getCode({ address })),
    getTransactionCount: ({ address, blockNumber, blockTag }: { address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }) => read("getTransactionCount", () => publicClient.getTransactionCount({ address, ...(blockNumber === undefined ? { blockTag: blockTag ?? "latest" } : { blockNumber }) })),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => read(`readContract:${args.functionName}`, () => publicClient.readContract(args as never)),
    call: (args: { data: Hex }) => read("call", () => publicClient.call(args)),
    getStorageAt: (args: { address: Address; slot: Hex }) => read("getStorageAt", () => publicClient.getStorageAt(args)),
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
      return { number: block.number, hash: block.hash, baseFeePerGas: block.baseFeePerGas, gasLimit: block.gasLimit };
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

/** Concrete local Sepolia composition. Phase One authorization is not independent. */
export async function createConfiguredAutomaticPwaProvisioner(config: BackendConfig): Promise<AutomaticPwaProvisioner> {
  if (config.id !== "local") throw new Error("automatic PWA provisioning is available only for BACKEND_PROFILE=local");
  const profile = loadCommittedPwaPhaseOneProfile();
  const policy = loadCommittedPwaProvisioningAutomationPolicy();
  const authorizer = createLocalPhaseOneProvisioningAuthorizer(policy);
  const account = privateKeyToAccount(config.relayPrivateKey);
  const relay = createRelayClient(config.rpcUrl);
  const providers = [
    createReadClient(PWA_IDENTITY_PROVIDERS[0], "identity provider 1"),
    createReadClient(PWA_IDENTITY_PROVIDERS[1], "identity provider 2"),
  ] as const;
  let recovery: PwaProvisioningRecovery | undefined;
  const startupJournal = readLiveJournal(config.provisioningJournalPath, account.address);
  if (startupJournal.entries.length > 0) {
    try {
      recovery = await resolvePwaProvisioningRecovery({ reviewDirectory: config.provisioningReviewDirectory, journal: startupJournal, profile, safeProxySaltNonce: policy.safeProxySaltNonce, providers, relay, successors: loadCommittedPwaProvisioningSuccessors() });
    } catch (error) {
      const detail = error instanceof Error && error.message.startsWith("fail closed: PWA provisioning recovery ") ? `: ${error.message}` : "";
      throw new Error(`automatic provisioning recovery validation failed closed${detail}`);
    }
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
      const authorizationStore = createPwaProvisioningAuthorizationStore(pwaProvisioningAuthorizationPath(config.provisioningJournalPath, packageHash), { chainId: sepolia.id, deployer: plan.deployer, packageHash, planHash: plan.planHash });
      try {
        const runtime = createPwaProvisioningRuntime({
          plan,
          journalPath: config.provisioningJournalPath,
          account,
          client: relay,
          async authorize(transaction: PwaProvisioningTransaction) {
            const facts = await authorizeNext(plan, transaction);
            const verified = assertPwaProvisioningTransactionAuthorization(plan, facts.authorization);
            authorizationStore.append(verified);
            await assertRelayQuoteAnchor(plan, transaction, facts.quote);
            return Object.freeze({ ...transaction, gasLimit: BigInt(verified.gasLimit), maxFeePerGas: BigInt(verified.maxFeePerGas), maxPriorityFeePerGas: BigInt(verified.maxPriorityFeePerGas) });
          },
        });
        return Object.freeze({ context: runtime.context, close: () => { runtime.close(); authorizationStore.close(); } });
      } catch (error) {
        authorizationStore.close();
        throw error;
      }
    },
  });
}
