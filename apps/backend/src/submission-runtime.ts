import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as namespace from "@tiered-spending-guard/security-core/pwa";
import type {
  PreparedPwaIntent,
  PwaIntent,
  VerifiedPwaSnapshot,
  PwaObservedState,
  PwaObserverClient,
  SubmissionRequest,
  RelayerContext,
} from "@tiered-spending-guard/security-core/pwa";
import type { BackendConfig } from "./config";
import type { BackendIntent, BackendVaultRecord } from "./handlers";
import type { ConfiguredSubmissionRuntime } from "./main";
import type { BackendApproval, BackendPreparedSubmission, BackendSubmissionReceipt } from "./vault";
import { SubmissionJournal } from "./journal";
import { createReadClient, sanitizeRpc } from "./provisioner";
import { persistPwaObservation } from "./observations";
import { batchedReadTransport } from "./batched-read-transport";
import { loadEvidenceAccess } from "./evidence-access";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
const ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function frozen() view returns (bool)",
  "function spendState(address) view returns (uint256,uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function txNonce() view returns (uint256)",
  "function queueNonce() view returns (uint256)",
  "function getTxHash(uint256) view returns (bytes32)",
  "function getTxCreatedAt(uint256) view returns (uint256)",
]);
const ADDED = parseAbiItem(
  "event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
);
const MAX_LOG_BLOCK_RANGE = 10_000n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const hash = (value: unknown) => keccak256(stringToHex(core.canonicalSubmissionJson(value)));

/** These capabilities are private to the backend; observer adapters below expose reads only. */
export function createSubmissionReadClient(
  url: string,
  label: string,
  options: Readonly<{ fetchFn?: typeof fetch }> = {},
) {
  const base = createReadClient(url, label, { batch: true, fetchFn: options.fetchFn });
  const client = createPublicClient({
    chain: sepolia,
    transport: batchedReadTransport(url, options.fetchFn),
  });
  const read = <T>(method: string, operation: () => Promise<T>) =>
    sanitizeRpc(label, method, operation, true);
  return Object.freeze({
    ...base,
    source: label.replaceAll(" ", "-"),
    getBalance: (args: { address: Address; blockNumber?: bigint }) =>
      read("getBalance", () => client.getBalance(args)),
    call: (args: {
      data: Hex;
      to?: Address;
      account?: Address;
      value?: bigint;
      blockNumber?: bigint;
    }) => read("call", () => client.call(args)),
    getLogs: (args: {
      address: Address;
      fromBlock: bigint;
      toBlock: bigint;
      args: { queueNonce: bigint };
    }) => read("getLogs", () => client.getLogs({ ...args, event: ADDED, strict: true })),
    getTransactionReceipt: ({ hash: transactionHash }: { hash: Hex }) =>
      read("getTransactionReceipt", async () => {
        try {
          const r = await client.getTransactionReceipt({ hash: transactionHash });
          return {
            transactionHash: r.transactionHash,
            status: r.status,
            gasUsed: r.gasUsed,
            effectiveGasPrice: r.effectiveGasPrice,
            blockNumber: r.blockNumber,
            blockHash: r.blockHash,
            logs: r.logs.map((log) => ({
              address: log.address,
              blockNumber: log.blockNumber,
              blockHash: log.blockHash,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
              topics: log.topics,
              data: log.data,
              removed: log.removed,
            })),
          };
        } catch (error) {
          if (error instanceof Error && error.name === "TransactionReceiptNotFoundError")
            return null;
          throw error;
        }
      }),
  });
}
type ReadClient = ReturnType<typeof createSubmissionReadClient>;
async function readDelayLogs(
  client: ReadClient,
  input: Readonly<{ address: Address; fromBlock: bigint; toBlock: bigint; queueNonce: bigint }>,
): Promise<Awaited<ReturnType<ReadClient["getLogs"]>>> {
  if (input.fromBlock > input.toBlock)
    throw new Error("Delay event scan boundary is in the future");
  const logs: Awaited<ReturnType<ReadClient["getLogs"]>> = [];
  for (let start = input.fromBlock; start <= input.toBlock; start += MAX_LOG_BLOCK_RANGE) {
    const end = start + MAX_LOG_BLOCK_RANGE - 1n;
    logs.push(
      ...(await client.getLogs({
        address: input.address,
        fromBlock: start,
        toBlock: end < input.toBlock ? end : input.toBlock,
        args: { queueNonce: input.queueNonce },
      })),
    );
  }
  return logs;
}
type Entry = {
  vault: BackendVaultRecord;
  intent: PwaIntent;
  snapshot: VerifiedPwaSnapshot;
  prepared: PreparedPwaIntent;
  publicPrepared: BackendPreparedSubmission;
};
type SignedEnvelope = {
  entry: Entry;
  request: SubmissionRequest | null;
  raw: Hex;
  hash: Hex;
  nonce: bigint;
  close(): void;
};
type Dependencies = Readonly<{
  providers: readonly [ReadClient, ReadClient];
  relay: ReadClient;
  beforeSign?(submissionId: string): void;
  sendRawTransaction(raw: Hex): Promise<Hex>;
}>;

function uint(value: unknown, label: string): bigint {
  if (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) < 1n << 256n
  )
    return BigInt(value);
  if (typeof value === "bigint" && value >= 0n && value < 1n << 256n) return value;
  throw new Error(`${label} must be a canonical nonnegative integer`);
}
function canonicalIntent(request: BackendIntent): PwaIntent {
  if (request.kind === "transfer" || request.kind === "add-recipient") {
    if (
      typeof request.recipient !== "string" ||
      !isAddress(request.recipient) ||
      isAddressEqual(request.recipient, ZERO)
    )
      throw new Error("recipient must be a nonzero address");
    const recipient = getAddress(request.recipient);
    return request.kind === "transfer"
      ? { kind: "transfer", recipient, amount: uint(request.amount, "amount") }
      : { kind: "add-recipient", recipient };
  }
  if (typeof request.queueFingerprint !== "string" || !bytes32.test(request.queueFingerprint))
    throw new Error("canonical queue fingerprint is required");
  return {
    kind: request.kind,
    queueNonce: uint(request.queueNonce, "queueNonce"),
    queueFingerprint: request.queueFingerprint.toLowerCase() as Hex,
  };
}
function semantic(prepared: PreparedPwaIntent): unknown {
  const {
    snapshotHash: _snapshotHash,
    blockNumber: _blockNumber,
    blockHash: _blockHash,
    timestamp: _timestamp,
    ...remaining
  } = prepared;
  return remaining;
}

function compose(
  config: BackendConfig,
  dependencies: Dependencies,
  currentVault?: () => BackendVaultRecord | undefined,
): ConfiguredSubmissionRuntime {
  if (config.id !== "local" || config.chainId !== 11155111)
    throw new Error("configured PWA submissions require the local Sepolia profile");
  const { providers, relay } = dependencies;
  if (providers[0].source === providers[1].source)
    throw new Error("two distinct fixed submission providers are required");
  const payer = privateKeyToAccount(config.relayPrivateKey);
  const policy = core.loadCommittedPwaProvisioningAutomationPolicy();
  const entries = new Map<string, Entry>();
  const envelopes = new Map<string, SignedEnvelope>();
  let activeEnvelope: string | undefined;
  const read = <T>(
    client: ReadClient,
    address: Address,
    functionName: string,
    blockNumber: bigint,
    args: readonly unknown[] = [],
  ) => client.readContract({ address, abi: ABI, functionName, args, blockNumber }) as Promise<T>;

  const stateAt = async (
    client: ReadClient,
    vault: BackendVaultRecord,
    blockNumber: bigint,
    recipient?: Address,
  ) => {
    if (!vault.provisioningPlan)
      throw new Error("original reviewed provisioning plan is required for submissions");
    const anchor = await client.getBlock({ blockNumber });
    if (anchor.number !== blockNumber || !anchor.hash || !bytes32.test(anchor.hash))
      throw new Error("submission state block is unavailable");
    const scoped = core.createPinnedReadScope(client, blockNumber);
    const proof = await core.verifyPwaSubmissionState({
      plan: vault.provisioningPlan,
      vault: vault.verifiedProvisioning,
      client: scoped,
      blockNumber,
    });
    const [safeNonce, spendState, queueHeadNonce, queueTailNonce, frozen] = await Promise.all([
      read<bigint>(scoped, vault.safe, "nonce", blockNumber),
      read<readonly [bigint, bigint, bigint]>(scoped, vault.guard, "spendState", blockNumber, [
        vault.usdc,
      ]),
      read<bigint>(scoped, vault.delay, "txNonce", blockNumber),
      read<bigint>(scoped, vault.delay, "queueNonce", blockNumber),
      read<boolean>(scoped, vault.guard, "frozen", blockNumber),
    ]);
    if (queueTailNonce < queueHeadNonce || queueTailNonce - queueHeadNonce > 128n)
      throw new Error("Delay queue is inconsistent or exceeds the supported bound");
    let queueHead: VerifiedPwaSnapshot["queueHead"] = null;
    if (queueHeadNonce < queueTailNonce) {
      const [fingerprint, createdAt, logs] = await Promise.all([
        read<Hex>(scoped, vault.delay, "getTxHash", blockNumber, [queueHeadNonce]),
        read<bigint>(scoped, vault.delay, "getTxCreatedAt", blockNumber, [queueHeadNonce]),
        readDelayLogs(client, {
          address: vault.delay,
          fromBlock: vault.verifiedProvisioning.setupReceipt.blockNumber,
          toBlock: blockNumber,
          queueNonce: queueHeadNonce,
        }),
      ]);
      if (logs.length !== 1) throw new Error("Delay head requires one canonical queue event");
      const log = logs[0]!;
      if (
        log.removed ||
        log.args.operation !== 0 ||
        log.args.to === undefined ||
        log.args.value === undefined ||
        log.args.data === undefined ||
        createdAt <= 0n ||
        log.args.txHash?.toLowerCase() !== fingerprint.toLowerCase()
      )
        throw new Error("Delay queue event identity is inconsistent");
      const item = {
        safe: vault.safe,
        delay: vault.delay,
        queueNonce: queueHeadNonce,
        to: getAddress(log.args.to),
        value: log.args.value,
        data: log.args.data,
        operation: 0 as const,
        createdAt,
        readyAt: createdAt + 120n,
        expiresAt: createdAt + 720n,
        queueFingerprint: fingerprint,
      };
      if (core.queueFingerprint(item) !== fingerprint)
        throw new Error("Delay queue fingerprint mismatch");
      queueHead = Object.freeze(item);
    }
    const asset = proof.policy.assets[0]!;
    const snapshotState = {
      deploymentsHash: proof.vault.deploymentsHash,
      policyHash: proof.vault.policyHash,
      safe: vault.safe,
      guard: vault.guard,
      delay: vault.delay,
      usdc: vault.usdc,
      primaryPasskey: vault.primaryPasskey,
      secondaryPasskey: vault.secondaryPasskey,
      baseRecipientMode: "any-valid-address" as const,
      elevatedRecipients: asset.recipients as readonly [Address, ...Address[]],
      safeNonce,
      spendState: { window: spendState[0], baseSpent: spendState[1], instantSpent: spendState[2] },
      limits: {
        basePerTransaction: asset.basePerTransaction,
        stepUpPerTransaction: asset.stepUpPerTransaction,
        baseDailyLimit: asset.baseDailyLimit,
        instantDailyLimit: asset.instantDailyLimit,
      },
      cooldownSeconds: 120n,
      expirationSeconds: 600n,
      queueHeadNonce,
      queueTailNonce,
      queueHead,
    };
    let balances: { safeUsdcBalance: bigint; recipientUsdcBalance: bigint } | undefined;
    if (recipient) {
      const [safeUsdcBalance, recipientUsdcBalance] = await Promise.all([
        read<bigint>(scoped, vault.usdc, "balanceOf", blockNumber, [vault.safe]),
        read<bigint>(scoped, vault.usdc, "balanceOf", blockNumber, [recipient]),
      ]);
      balances = { safeUsdcBalance, recipientUsdcBalance };
    }
    const block = await client.getBlock({ blockNumber });
    if (
      block.number !== blockNumber ||
      block.hash?.toLowerCase() !== anchor.hash.toLowerCase() ||
      block.timestamp !== anchor.timestamp
    )
      throw new Error("submission state block changed during collection");
    return { proof, snapshotState, block, frozen, balances };
  };

  const snapshotAt = async (vault: BackendVaultRecord, at?: bigint) => {
    const heads = await Promise.all(providers.map((client) => client.getBlockNumber()));
    if (heads[0] > heads[1] + 2n || heads[1] > heads[0] + 2n)
      throw new Error("submission providers disagree on chain height");
    const blockNumber = at ?? (heads[0] < heads[1] ? heads[0] : heads[1]);
    const values = await Promise.all(
      providers.map(async (client) => {
        const value = await stateAt(client, vault, blockNumber);
        const snapshot = await core.captureVerifiedPwaSnapshot(value.proof.vault, blockNumber, {
          getBlock: client.getBlock,
          readAt: async () => value.snapshotState,
        });
        if (
          snapshot.blockHash.toLowerCase() !== value.block.hash!.toLowerCase() ||
          snapshot.timestamp !== value.block.timestamp
        )
          throw new Error("submission snapshot block changed after collection");
        return { ...value, snapshot };
      }),
    );
    if (
      core.canonicalSubmissionJson(values[0]!.snapshot) !==
        core.canonicalSubmissionJson(values[1]!.snapshot) ||
      values[0]!.frozen !== values[1]!.frozen
    )
      throw new Error("submission providers disagree on the canonical snapshot");
    return { snapshot: values[0]!.snapshot, proof: values[0]!.proof, frozen: values[0]!.frozen };
  };

  const entryFor = (prepared: BackendPreparedSubmission) => {
    const entry = entries.get(prepared.id);
    if (
      !entry ||
      core.canonicalSubmissionJson(entry.publicPrepared) !== core.canonicalSubmissionJson(prepared)
    )
      throw new Error("server-held prepared intent is required");
    return entry;
  };
  const revalidatedSnapshot = async (prepared: BackendPreparedSubmission) => {
    const entry = entryFor(prepared);
    const originalBlocks = await Promise.all(
      providers.map((client) => client.getBlock({ blockNumber: entry.prepared.blockNumber })),
    );
    if (
      originalBlocks.some(
        (block) => block.hash?.toLowerCase() !== entry.prepared.blockHash.toLowerCase(),
      )
    )
      throw new Error("prepared snapshot block changed");
    const fresh = await snapshotAt(entry.vault);
    if (fresh.frozen && ["base-transfer", "step-up-transfer"].includes(entry.prepared.kind))
      throw new Error("instant spending is frozen");
    const actual = core.preparePwaIntent(fresh.snapshot, entry.intent);
    if (
      core.canonicalSubmissionJson(semantic(actual)) !==
      core.canonicalSubmissionJson(semantic(entry.prepared))
    )
      throw new Error("prepared intent is stale after policy, nonce, counters, or queue drift");
    return fresh;
  };
  const revalidate = async (prepared: BackendPreparedSubmission): Promise<void> => {
    await revalidatedSnapshot(prepared);
  };
  const discard = (prepared: BackendPreparedSubmission) => {
    const envelope = envelopes.get(prepared.id);
    if (envelope) {
      envelope.close();
      envelopes.delete(prepared.id);
    }
    if (activeEnvelope === prepared.id) activeEnvelope = undefined;
  };

  const recoverEntry = async (transactionHash: Hex): Promise<Entry | undefined> => {
    const journal = new SubmissionJournal(config.journalPath);
    const stored = journal.findByOuterHash(transactionHash);
    const vault = currentVault?.();
    if (!stored || !vault) return undefined;
    const publicIntent = stored.publicRequest.intent;
    const preparedBlock = stored.publicRequest.preparedBlockNumber;
    if (
      !publicIntent ||
      typeof publicIntent !== "object" ||
      typeof preparedBlock !== "string" ||
      !/^\d+$/.test(preparedBlock)
    )
      throw new Error("durable submission reconstruction metadata is missing");
    const rawIntent = publicIntent as Record<string, unknown>;
    const request = {
      ...rawIntent,
      ...(rawIntent.kind === "transfer" ? { amount: BigInt(String(rawIntent.amount)) } : {}),
      ...("queueNonce" in rawIntent ? { queueNonce: BigInt(String(rawIntent.queueNonce)) } : {}),
    } as BackendIntent;
    const intent = canonicalIntent(request);
    const { snapshot } = await snapshotAt(vault, BigInt(preparedBlock));
    const prepared = core.preparePwaIntent(snapshot, intent);
    if (hash(prepared) !== stored.requestHash.toLowerCase())
      throw new Error("reconstructed submission does not match durable intent hash");
    const publicPrepared: BackendPreparedSubmission = Object.freeze({
      id: stored.id,
      requestHash: stored.requestHash as Hex,
      ...("safeTxHash" in prepared ? { safeTxHash: prepared.safeTxHash } : {}),
      kind: prepared.kind,
      requiredApprovals: prepared.requiredApprovals,
      publicRequest: stored.publicRequest,
    });
    const entry = { vault, intent, snapshot, prepared, publicPrepared };
    entries.set(stored.id, entry);
    return entry;
  };

  const reconcile = async (transactionHash: Hex): Promise<BackendSubmissionReceipt | undefined> => {
    const receipts = await Promise.all(
      providers.map((client) => client.getTransactionReceipt({ hash: transactionHash })),
    );
    if (receipts.some((receipt) => !receipt)) return undefined;
    const first = receipts[0]!;
    if (first.transactionHash.toLowerCase() !== transactionHash.toLowerCase())
      throw new Error("receipt does not match the durable submission hash");
    if (first.status !== "success" && first.status !== "reverted")
      throw new Error("submission receipt has an invalid status");
    if (core.canonicalSubmissionJson(first) !== core.canonicalSubmissionJson(receipts[1]))
      throw new Error("submission receipt providers disagree");
    const [heads, blocks] = await Promise.all([
      Promise.all(providers.map((client) => client.getBlockNumber())),
      Promise.all(providers.map((client) => client.getBlock({ blockNumber: first.blockNumber }))),
    ]);
    if (heads.some((head) => head < first.blockNumber + 5n)) return undefined;
    if (
      blocks.some(
        (block) =>
          block.number !== first.blockNumber ||
          block.hash?.toLowerCase() !== first.blockHash.toLowerCase(),
      )
    )
      throw new Error("submission receipt is not canonical");
    const envelope = [...envelopes.values()].find(
      (value) => value.hash.toLowerCase() === transactionHash.toLowerCase(),
    );
    const entry =
      envelope?.entry ??
      [...entries.values()].find(
        (value) =>
          new SubmissionJournal(config.journalPath)
            .get(value.publicPrepared.id)
            ?.outerTransactionHash?.toLowerCase() === transactionHash.toLowerCase(),
      ) ??
      (await recoverEntry(transactionHash));
    if (!entry)
      throw new Error("durable server-held submission evidence is required for reconciliation");
    if (first.status === "success") {
      const clients = providers.map((client) =>
        Object.freeze({
          source: client.source,
          getBlockNumber: client.getBlockNumber,
          getTransactionReceipt: client.getTransactionReceipt,
          getTransaction: client.getTransaction,
          getBlock: client.getBlock,
          readStateAt: async (blockNumber: bigint): Promise<PwaObservedState> => {
            const state = await stateAt(client, entry.vault, blockNumber, entry.prepared.recipient);
            return {
              policy: state.proof.policy,
              safeNonce: state.snapshotState.safeNonce,
              queueHeadNonce: state.snapshotState.queueHeadNonce,
              queueTailNonce: state.snapshotState.queueTailNonce,
              safeUsdcBalance: state.balances!.safeUsdcBalance,
              recipientUsdcBalance: state.balances!.recipientUsdcBalance,
              spendState: state.snapshotState.spendState,
              queueHead: state.snapshotState.queueHead,
              deploymentsHash: state.proof.vault.deploymentsHash,
              policyHash: state.proof.vault.policyHash,
              topologyReportHash: state.proof.topologyReportHash,
            };
          },
        }),
      ) as unknown as readonly [PwaObserverClient, PwaObserverClient];
      const record = await core.observePwaReceipt(
        {
          intent: entry.prepared,
          profileHash: hash(core.loadCommittedPwaPhaseOneProfile()),
          topologyReportHash: entry.vault.verifiedProvisioning.topologyReportHash,
          confirmations: 6,
          observer: {
            processId: `backend-observer-${process.pid}`,
            executableHash: `0x${createHash("sha256")
              .update(readFileSync(new URL(import.meta.url)))
              .digest("hex")}`,
            startedAt: new Date().toISOString(),
          },
          clients,
        },
        transactionHash,
      );
      persistPwaObservation(`${config.journalPath}.observations`, record);
    }
    if (envelope) discard(entry.publicPrepared);
    return {
      status: first.status === "success" ? "confirmed" : "reverted",
      transactionHash,
      blockNumber: first.blockNumber,
      blockHash: first.blockHash,
    };
  };

  return Object.freeze({
    async prepare({ vault, request }) {
      if (
        typeof request.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(request.idempotencyKey)
      )
        throw new Error("idempotency key is invalid");
      const intent = canonicalIntent(request);
      const existing = entries.get(request.idempotencyKey);
      if (existing) {
        if (core.canonicalSubmissionJson(existing.intent) !== core.canonicalSubmissionJson(intent))
          throw new Error("idempotency key is already bound to another intent");
        return existing.publicPrepared;
      }
      const { snapshot, frozen } = await snapshotAt(vault);
      const prepared = core.preparePwaIntent(snapshot, intent);
      if (frozen && ["base-transfer", "step-up-transfer"].includes(prepared.kind))
        throw new Error("instant spending is frozen");
      const simulations = await Promise.all(
        providers.map((client) => core.simulatePwaIntent(prepared, client)),
      );
      if (simulations.some((evidence) => !evidence.ok))
        throw new Error("prepared intent simulation failed");
      const publicRequest = Object.freeze({
        ...request,
        intent: JSON.parse(core.canonicalSubmissionJson(intent)),
        preparedBlockNumber: String(prepared.blockNumber),
      });
      const publicPrepared: BackendPreparedSubmission = Object.freeze({
        id: request.idempotencyKey,
        requestHash: hash(prepared),
        ...("safeTxHash" in prepared ? { safeTxHash: prepared.safeTxHash } : {}),
        kind: prepared.kind,
        requiredApprovals: prepared.requiredApprovals,
        publicRequest,
      });
      const raced = entries.get(publicPrepared.id);
      if (raced) {
        if (core.canonicalSubmissionJson(raced.intent) !== core.canonicalSubmissionJson(intent))
          throw new Error("idempotency key is already bound to another intent");
        return raced.publicPrepared;
      }
      entries.set(publicPrepared.id, { vault, intent, snapshot, prepared, publicPrepared });
      return publicPrepared;
    },
    revalidate,
    async deriveOuterHash(prepared, approvals) {
      const entry = entryFor(prepared);
      if (activeEnvelope)
        throw new Error("another payer operation is pending; reconcile it before signing");
      const lease = core.createPwaProvisioningRuntime({
        plan: entry.vault.provisioningPlan!,
        journalPath: config.provisioningJournalPath,
        account: payer,
        client: relay,
      });
      activeEnvelope = prepared.id;
      try {
        if (new SubmissionJournal(config.journalPath).listPending().length)
          throw new Error(
            "a durable submission is unresolved; reconcile its exact hash before signing",
          );
        const fresh = await revalidatedSnapshot(prepared);
        const idempotencyKey = keccak256(stringToHex(prepared.id));
        let request: SubmissionRequest | null;
        let to: Address, data: Hex;
        if ("safeTx" in entry.prepared) {
          const primary = approvals.find((approval) => approval.role === "primary");
          const secondary = approvals.find((approval) => approval.role === "secondary");
          if (
            !primary ||
            approvals.length !== entry.prepared.requiredApprovals.length ||
            (entry.prepared.requiredApprovals.some((role) => role === "secondary") && !secondary)
          )
            throw new Error("exact required approvals are missing");
          const signatures = core.encodeGuardContractSignatures(
            { address: entry.vault.primaryPasskey, payload: primary.payload },
            secondary
              ? { address: entry.vault.secondaryPasskey, payload: secondary.payload }
              : undefined,
          );
          request = {
            version: 1,
            kind: "safe-execution",
            idempotencyKey,
            chainId: 11155111,
            deploymentsHash: core.deploymentInfrastructureHash(fresh.proof.deployments),
            policyHash: entry.prepared.policyHash,
            safe: entry.prepared.safe,
            guard: entry.prepared.guard,
            asset: entry.prepared.asset,
            transaction: entry.prepared.safeTx,
            safeTxHash: entry.prepared.safeTxHash,
            signatures,
            expectedSpend: entry.prepared.expectedSpend,
          };
          to = request.safe;
          data = core.encodeSafeExecutionCalldata(request);
        } else if (entry.prepared.kind === "execute-ready") {
          if (approvals.length)
            throw new Error("permissionless execution does not accept approvals");
          const queue = entry.prepared.queue;
          request = {
            version: 1,
            kind: "delay-execution",
            idempotencyKey,
            chainId: 11155111,
            deploymentsHash: core.deploymentInfrastructureHash(fresh.proof.deployments),
            policyHash: entry.prepared.policyHash,
            safe: entry.prepared.safe,
            guard: entry.prepared.guard,
            delay: entry.prepared.delay,
            queueNonce: queue.queueNonce,
            queueFingerprint: queue.queueFingerprint,
            to: queue.to,
            value: queue.value,
            data: queue.data,
            operation: queue.operation,
            createdAt: queue.createdAt,
            cooldownSeconds: 120n,
            expirationSeconds: 600n,
          };
          to = request.delay;
          data = core.encodeDelayExecutionCalldata(request);
        } else {
          if (approvals.length || entry.prepared.kind !== "skip-expired")
            throw new Error("unsupported direct lifecycle transaction");
          // skipExpired has a separate closed prepared call; it cannot enter generic Delay execution.
          request = null;
          to = entry.prepared.call.to;
          data = entry.prepared.call.data;
        }
        const nonces = await Promise.all(
          [...providers, relay].map(async (client) => {
            const [latest, pending] = await Promise.all([
              client.getTransactionCount({ address: payer.address, blockTag: "latest" }),
              client.getTransactionCount({ address: payer.address, blockTag: "pending" }),
            ]);
            if (BigInt(latest) !== BigInt(pending))
              throw new Error("payer has an outstanding transaction");
            return BigInt(latest);
          }),
        );
        if (
          nonces.some((nonce) => nonce !== nonces[0]) ||
          nonces[0]! > BigInt(Number.MAX_SAFE_INTEGER)
        )
          throw new Error("payer nonce providers disagree");
        const blockNumber = fresh.snapshot.blockNumber;
        const blocks = await Promise.all(
          [...providers, relay].map((client) => client.getBlock({ blockNumber })),
        );
        if (
          blocks.some(
            (block) =>
              block.hash !== fresh.snapshot.blockHash ||
              block.baseFeePerGas === null ||
              block.baseFeePerGas === undefined ||
              block.gasLimit === undefined,
          )
        )
          throw new Error("payer quote block disagrees");
        const [estimates, tips, relayBalance] = await Promise.all([
          Promise.all(
            providers.map((client) =>
              client.estimateGas({ account: payer.address, to, data, value: 0n, blockNumber }),
            ),
          ),
          Promise.all(providers.map((client) => client.getMaxPriorityFeePerGas())),
          relay.getBalance({ address: payer.address }),
        ]);
        const envelope = core.derivePwaProvisioningEnvelope({
          estimates: estimates as [bigint, bigint],
          priorityFeesPerGas: tips as [bigint, bigint],
          blockGasLimit: blocks[0]!.gasLimit!,
          baseFeePerGas: blocks[0]!.baseFeePerGas!,
          value: 0n,
          confirmedActualCost: 0n,
          pendingReservation: 0n,
          relayBalance,
          policy,
        });
        dependencies.beforeSign?.(prepared.id);
        const raw = await payer.signTransaction({
          chainId: 11155111,
          type: "eip1559",
          to,
          value: 0n,
          data,
          nonce: Number(nonces[0]!),
          gas: envelope.gasLimit,
          maxFeePerGas: envelope.maxFeePerGas,
          maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
        });
        const outerHash = keccak256(raw);
        envelopes.set(prepared.id, {
          entry,
          request,
          raw,
          hash: outerHash,
          nonce: nonces[0]!,
          close: lease.close,
        });
        return outerHash;
      } catch (error) {
        lease.close();
        activeEnvelope = undefined;
        throw error;
      }
    },
    async broadcast(prepared, _approvals, expectedHash) {
      const envelope = envelopes.get(prepared.id);
      if (!envelope || envelope.hash !== expectedHash || keccak256(envelope.raw) !== expectedHash)
        throw new Error("exact signed envelope is unavailable");
      const durable = new SubmissionJournal(config.journalPath).get(prepared.id);
      if (
        durable?.outerTransactionHash?.toLowerCase() !== expectedHash.toLowerCase() ||
        durable.state !== "submitting"
      )
        throw new Error("signed hash must be durable before broadcast");
      const fresh = await revalidatedSnapshot(prepared);
      const checkPayer = async () => {
        const states = await Promise.all(
          [...providers, relay].map(async (client) => {
            const [chainId, latest, pending] = await Promise.all([
              client.getChainId(),
              client.getTransactionCount({ address: payer.address, blockTag: "latest" }),
              client.getTransactionCount({ address: payer.address, blockTag: "pending" }),
            ]);
            return { chainId, latest: BigInt(latest), pending: BigInt(pending) };
          }),
        );
        if (
          states.some(
            (state) =>
              state.chainId !== 11155111 ||
              state.latest !== envelope.nonce ||
              state.pending !== envelope.nonce,
          )
        )
          throw new Error("payer chain or nonce changed before broadcast");
      };
      if (envelope.entry.prepared.kind === "skip-expired") {
        await checkPayer();
        dependencies.beforeSign?.(prepared.id);
        return dependencies.sendRawTransaction(envelope.raw);
      }
      const request = envelope.request;
      if (!request) throw new Error("reviewed transport request is missing");
      const snapshot = fresh.snapshot;
      const send = async (target: Address, data: Hex) => {
        const expectedTo = request.kind === "safe-execution" ? request.safe : request.delay;
        const expectedData =
          request.kind === "safe-execution"
            ? core.encodeSafeExecutionCalldata(request)
            : core.encodeDelayExecutionCalldata(request);
        if (!isAddressEqual(target, expectedTo) || data !== expectedData)
          throw new Error("transport altered the signed outer call");
        await revalidate(prepared);
        await checkPayer();
        dependencies.beforeSign?.(prepared.id);
        return dependencies.sendRawTransaction(envelope.raw);
      };
      const context: RelayerContext = {
        readers: {
          chainId: async () => providers[0].getChainId(),
          deployments: async () => fresh.proof.deployments,
          topology: async () => fresh.proof.topologyReport,
          safeNonce: async () => snapshot.safeNonce,
          policyHash: async () => snapshot.policyHash,
          spendState: async () => snapshot.spendState,
          delayItem: async () => {
            if (!snapshot.queueHead) throw new Error("reviewed queue head is missing");
            return { ...snapshot.queueHead, txHash: snapshot.queueHead.queueFingerprint };
          },
          delayNonce: async () => snapshot.queueHeadNonce,
          blockTimestamp: async () => snapshot.timestamp,
          receipt: async () => undefined,
        },
        broadcaster: { executeSafe: send, executeDelay: send },
      };
      const result = await core.validateAndBroadcast(request, context);
      if (result.kind !== "submitted" && result.kind !== "confirmed")
        throw new Error(
          `reviewed submission transport rejected the current state: ${result.kind}: ${result.reason}`,
        );
      if (result.transactionHash !== expectedHash)
        throw new Error("transport returned a different transaction hash");
      return result.transactionHash;
    },
    reconcile,
    discard,
  });
}

export function createConfiguredSubmissionRuntime(
  config: BackendConfig,
  currentVault?: () => BackendVaultRecord | undefined,
  beforeSign?: (submissionId: string) => void,
): ConfiguredSubmissionRuntime {
  const access = loadEvidenceAccess(config.evidenceConfigPath);
  const providers = [
    createSubmissionReadClient(access.urls[0], access.operators[0]),
    createSubmissionReadClient(access.urls[1], access.operators[1]),
  ] as const;
  const relay = createSubmissionReadClient(config.rpcUrl, "submission relay");
  const client = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  return compose(
    config,
    {
      providers,
      relay,
      beforeSign,
      sendRawTransaction: (serializedTransaction) =>
        sanitizeRpc("submission relay", "sendRawTransaction", () =>
          client.sendRawTransaction({ serializedTransaction }),
        ),
    },
    currentVault,
  );
}

export function createSubmissionRuntimeForTestsOnly(
  config: BackendConfig,
  dependencies: Dependencies,
  currentVault?: () => BackendVaultRecord | undefined,
): ConfiguredSubmissionRuntime {
  if (process.env.NODE_ENV !== "test")
    throw new Error("test-only submission dependencies are disabled");
  return compose(config, dependencies, currentVault);
}
