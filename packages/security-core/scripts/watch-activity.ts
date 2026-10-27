import { createPublicClient, decodeEventLog, decodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { decodeDelayLog, delayEventAbi, deriveDelayLifecycle, verifyDelayBinding, type DelayMonitoringContext, type DelayedQueuedAlert, type MonitorLog, type QueueBinding } from "../src/monitoring/delay-events";
import { decodeGuardLog, type MonitoringIdentity } from "../src/monitoring/guard-events";
import { createRpcGuardBinding, type RpcGuardClient } from "../src/monitoring/guard-rpc-binding";
import { ActivityLedger, FileActivityStore, type ActivityLogKey } from "../src/monitoring/ledger";
import { createLiveWebhookNotifier, deliverPendingAlerts, scanFailClosed } from "../src/monitoring/watcher-runtime";

const env = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`missing ${name}`); return value; };
const address = (name: string): Address => env(name) as Address;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const safeAbi = parseAbi([
  "function getTxHash(uint256) view returns (bytes32)",
  "function getTxCreatedAt(uint256) view returns (uint256)",
  "function txNonce() view returns (uint256)",
  "function executeNextTx(address,uint256,bytes,uint8)",
  "function skipExpired()",
  "function setTxNonce(uint256)",
]);
const lifecycleAbi = parseAbi(["function executeNextTx(address,uint256,bytes,uint8)","function skipExpired()","function setTxNonce(uint256)"]);
type RawLog = { address: Address; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: number; topics: readonly Hex[]; data: Hex; removed?: boolean };

async function main(): Promise<void> {
  const expectedChain = Number(env("MONITOR_CHAIN_ID"));
  if (!Number.isSafeInteger(expectedChain) || expectedChain <= 0) throw new Error("invalid MONITOR_CHAIN_ID");
  const safe = address("MONITOR_SAFE");
  const guard = address("MONITOR_GUARD");
  const delay = address("MONITOR_DELAY");
  const notifier = createLiveWebhookNotifier(process.env);
  const client = createPublicClient({ transport: http(env("MONITOR_RPC_URL")) });
  const rpcChain = await client.getChainId();
  if (rpcChain !== expectedChain) throw new Error(`RPC chain identity mismatch: expected ${expectedChain}, got ${rpcChain}`);
  const confirmations = Number(process.env.MONITOR_CONFIRMATIONS ?? "6");
  const fromBlock = BigInt(env("MONITOR_FROM_BLOCK"));
  const latest = await client.getBlockNumber();
  const identity: MonitoringIdentity = { chainId: rpcChain, safe, guard, delay, confirmations };
  const delayContext: DelayMonitoringContext = { chainId: rpcChain, safe, delay, confirmations, cooldownSeconds: BigInt(env("MONITOR_COOLDOWN")), expirationSeconds: BigInt(process.env.MONITOR_EXPIRATION ?? "0") };
  const store = new FileActivityStore(env("MONITOR_STATE_FILE"));
  try {
    const ledger = new ActivityLedger(store);
    const cursor = ledger.cursor();
    const start = cursor && cursor.blockNumber >= fromBlock ? cursor.blockNumber : fromBlock;
    const canonical = new Map<number, Hex>();
    for (const record of ledger.records()) {
      if (record.chainId !== rpcChain) continue;
      const block = await client.getBlock({ blockNumber: record.blockNumber });
      if (!block.hash) throw new Error("missing canonical record block hash");
      canonical.set(Number(record.blockNumber), block.hash);
    }
    ledger.reconcileCanonical(rpcChain, blockNumber => canonical.get(blockNumber));
    const [guardLogs, delayLogs] = await Promise.all([
      client.getLogs({ address: guard, fromBlock: start, toBlock: latest }),
      client.getLogs({ address: delay, fromBlock: start, toBlock: latest }),
    ]);
    const asMonitorLog = (log: RawLog): MonitorLog => ({ ...log, chainId: rpcChain });
    const readDelayQueueMetadata = async (queueNonce: bigint, blockNumber: bigint) => Promise.all([
      client.readContract({ address: delay, abi: safeAbi, functionName: "getTxHash", args: [queueNonce], blockNumber }),
      client.readContract({ address: delay, abi: safeAbi, functionName: "getTxCreatedAt", args: [queueNonce], blockNumber }),
    ]);
    const readDelayNonce = (blockNumber: bigint) => client.readContract({ address: delay, abi: safeAbi, functionName: "txNonce", blockNumber });
    const guardBinding = createRpcGuardBinding(client as unknown as RpcGuardClient, identity);
    const ordered = [...guardLogs, ...delayLogs].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber));
    await scanFailClosed(ordered, async raw => {
      const log = asMonitorLog(raw as RawLog);
      const key: ActivityLogKey = { chainId: rpcChain, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex };
        if (log.removed) { ledger.remove(key); return; }
        if (same(log.address, guard)) {
          const alert = await decodeGuardLog(log, identity, latest, guardBinding);
          if (alert) ledger.accept(key, alert);
          return;
        }
        const eventBlock = await client.getBlock({ blockNumber: log.blockNumber });
        if (!eventBlock.hash) throw new Error("missing event block hash");
        const queueBinding: QueueBinding = {
          readNonce: readDelayNonce,
          readQueue: async (queueNonce, blockNumber) => {
            const [txHash, createdAt] = await readDelayQueueMetadata(queueNonce, blockNumber);
            const decoded = decodeEventLog({ abi: delayEventAbi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
            const values = (Array.isArray(decoded.args) ? decoded.args : Object.values(decoded.args)) as readonly unknown[];
            if (decoded.eventName !== "TransactionAdded") throw new Error("queue tuple unavailable for lifecycle event");
            return { txHash, createdAt, to: values[2] as Address, value: values[3] as bigint, data: values[4] as Hex, operation: values[5] as number };
          },
        };
        const alert = await decodeDelayLog(log, delayContext, latest, eventBlock.timestamp, queueBinding);
        await verifyDelayBinding(alert, queueBinding, delayContext);
        ledger.accept(key, alert);
    }, raw => `${raw.transactionHash}:${raw.logIndex}`);
    const queued = ledger.records().filter((record): record is DelayedQueuedAlert => record.kind === "delayed-queued" && record.queueNonce !== undefined && record.queueFingerprint !== undefined && record.createdAt !== undefined);
    const lifecycleFrom = queued.reduce((minimum, record) => record.blockNumber < minimum ? record.blockNumber + 1n : minimum, fromBlock);
    async function readLifecycleReceipts(from: bigint, to: bigint) {
      const receipts: { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: "success"|"reverted"; to: Address; input: Hex }[] = [];
      for (let number=from; number<=to; number++) {
        const block = await client.getBlock({ blockNumber: number, includeTransactions: true });
        if (!block.hash || !block.transactions.length || typeof block.transactions[0] === "string") continue;
        for (const transaction of block.transactions) {
          if (!transaction.to || !same(transaction.to, delay)) continue;
          const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
          if (latest-receipt.blockNumber+1n<BigInt(confirmations)) continue;
          receipts.push({ transactionHash: transaction.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status, to: transaction.to, input: transaction.input });
        }
      }
      return receipts;
    }
    const lifecycleReceipts = lifecycleFrom <= latest ? await readLifecycleReceipts(lifecycleFrom, latest) : [];
    await scanFailClosed(queued, async record => {
        if (record.to === undefined || record.value === undefined || record.data === undefined || record.operation === undefined) throw new Error("queued call tuple evidence unavailable");
        const lifecycle = await deriveDelayLifecycle(record, delayContext, latest, {
          readNonce: readDelayNonce,
          readQueue: async (queueNonce, blockNumber) => {
            const [txHash, createdAt] = await readDelayQueueMetadata(queueNonce, blockNumber);
            return { txHash, createdAt, to: record.to!, value: record.value!, data: record.data!, operation: record.operation! };
          },
          readLifecycleReceipts: async () => lifecycleReceipts,
          readCanonicalBlock: async blockNumber => { const block = await client.getBlock({ blockNumber }); if (!block.hash) throw new Error("missing canonical lifecycle block hash"); return { blockNumber, blockHash: block.hash, timestamp: block.timestamp }; },
          decodeLifecycleCall: input => { const decoded = decodeFunctionData({ abi: lifecycleAbi, data: input }); return { functionName: decoded.functionName as "executeNextTx"|"skipExpired"|"setTxNonce", args: decoded.args as readonly unknown[] }; },
        });
        if (lifecycle) { const block = await client.getBlock({ blockNumber: lifecycle.blockNumber }); if (!block.hash) throw new Error("missing derived lifecycle block hash"); ledger.accept({ chainId: rpcChain, blockHash: block.hash, transactionHash: lifecycle.transactionHash, logIndex: lifecycle.logIndex }, lifecycle); }
    }, record => `queue-${record.queueNonce}`);
    await deliverPendingAlerts(ledger, notifier);
  } finally { store.close(); }
}

main().catch(() => { console.error("activity observer failed"); process.exitCode = 1; });
