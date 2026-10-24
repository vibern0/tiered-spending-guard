import { keccak256, parseTransaction, recoverTransactionAddress, stringToHex, type Address, type Hex } from "viem";

export const SEPOLIA = 11155111;
export const PHASE_OUTLAY_LIMIT = 50_000_000_000_000_000n;
export type LiveIntent = Readonly<{ id: string; to?: Address; data: Hex; value: bigint; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
export type LiveReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint; blockHash: Hex }>;
export type JournalEntry = { id: string; intentHash: Hex; transactionHash: Hex; nonce: number; reserved: bigint; status: "pending" | "success" | "reverted"; receipt?: LiveReceipt };
export type LiveJournal = { chainId: number; funder: Address; entries: JournalEntry[] };
// The adapter must hold an exclusive journal lock for the entire operation and
// return only canonical, sufficiently confirmed receipts. This is not a live CLI.
export type LiveContext = Readonly<{
  funder: Address;
  chainId(): Promise<number>;
  nonce(): Promise<number>;
  balance(): Promise<bigint>;
  verify(): Promise<void>;
  sign(intent: LiveIntent): Promise<Hex>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<LiveReceipt | undefined>;
  persist(journal: LiveJournal): Promise<void>;
}>;

export function liveIntentHash(intent: LiveIntent, funder: Address): Hex {
  return keccak256(stringToHex(JSON.stringify([
    SEPOLIA, funder.toLowerCase(), intent.id, intent.to?.toLowerCase() ?? null, intent.data.toLowerCase(),
    intent.value.toString(), intent.nonce, intent.gas.toString(), intent.maxFeePerGas.toString(), intent.maxPriorityFeePerGas.toString(),
  ])));
}

export async function submitLiveIntent(input: LiveIntent, journal: LiveJournal, context: LiveContext): Promise<JournalEntry> {
  const intent = Object.freeze({ ...input });
  if (await context.chainId() !== SEPOLIA) throw new Error("live runner requires Ethereum Sepolia");
  if (journal.chainId !== SEPOLIA || journal.funder.toLowerCase() !== context.funder.toLowerCase()) throw new Error("journal identity mismatch");
  if (!/^[a-z0-9-]{1,80}$/.test(intent.id) || !/^0x(?:[0-9a-f]{2})*$/i.test(intent.data) || (intent.to !== undefined && !/^0x[0-9a-f]{40}$/i.test(intent.to))) throw new Error("invalid live intent");
  if (!Number.isSafeInteger(intent.nonce) || intent.nonce < 0 || intent.value < 0n || intent.gas <= 0n || intent.maxFeePerGas <= 0n || intent.maxPriorityFeePerGas < 0n || intent.maxPriorityFeePerGas > intent.maxFeePerGas) throw new Error("invalid transaction bounds");
  const intentHash = liveIntentHash(intent, context.funder);
  const existing = journal.entries.find(entry => entry.id === intent.id);
  if (existing) {
    if (existing.intentHash !== intentHash) throw new Error("resume intent changed");
    const receipt = await context.receipt(existing.transactionHash);
    if (!receipt) {
      existing.status = "pending";
      existing.receipt = undefined;
      existing.reserved = intent.value + intent.gas * intent.maxFeePerGas;
      await context.persist(journal);
      return existing;
    }
    if (receipt.transactionHash !== existing.transactionHash || receipt.gasUsed < 0n || receipt.gasUsed > intent.gas || receipt.effectiveGasPrice < 0n || receipt.effectiveGasPrice > intent.maxFeePerGas) throw new Error("receipt inconsistent with signed transaction");
    existing.status = receipt.status;
    existing.receipt = receipt;
    existing.reserved = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.status === "success" ? intent.value : 0n);
    await context.persist(journal);
    return existing;
  }
  if (journal.entries.some(entry => entry.status === "pending")) throw new Error("reconcile pending submission first");
  for (const entry of journal.entries) {
    const current = await context.receipt(entry.transactionHash);
    const prior = entry.receipt;
    if (!current || !prior || current.transactionHash !== entry.transactionHash || current.blockHash !== prior.blockHash || current.blockNumber !== prior.blockNumber || current.status !== prior.status || current.gasUsed !== prior.gasUsed || current.effectiveGasPrice !== prior.effectiveGasPrice) throw new Error("prior receipt changed; reconcile original intent first");
  }
  if (journal.entries.some(entry => entry.nonce === intent.nonce)) throw new Error("funder nonce already journaled");
  const reserved = intent.value + intent.gas * intent.maxFeePerGas;
  const spent = journal.entries.reduce((sum, entry) => {
    if (entry.reserved < 0n) throw new Error("invalid journal accounting");
    return sum + entry.reserved;
  }, 0n);
  if (spent + reserved > PHASE_OUTLAY_LIMIT) throw new Error("phase outlay limit exceeded");
  await context.verify();
  if (await context.nonce() !== intent.nonce) throw new Error("funder nonce drift");
  if (await context.balance() < reserved) throw new Error("insufficient funder balance");
  // Recheck identity after RPC-backed verification, before signing or reserving funds.
  if (await context.chainId() !== SEPOLIA) throw new Error("chain changed during preflight");
  let raw: Hex;
  try { raw = await context.sign(intent); } catch { throw new Error("local transaction signing failed"); }
  try {
    const signed = parseTransaction(raw);
    if (!raw.startsWith("0x02")) throw new Error("mismatch");
    const sender = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
    if (signed.type !== "eip1559" || signed.chainId !== SEPOLIA || sender.toLowerCase() !== context.funder.toLowerCase() || signed.to?.toLowerCase() !== intent.to?.toLowerCase() || (signed.data ?? "0x").toLowerCase() !== intent.data.toLowerCase() || (signed.value ?? 0n) !== intent.value || signed.nonce !== intent.nonce || signed.gas !== intent.gas || signed.maxFeePerGas !== intent.maxFeePerGas || signed.maxPriorityFeePerGas !== intent.maxPriorityFeePerGas || (signed.accessList?.length ?? 0) !== 0) throw new Error("mismatch");
  } catch { throw new Error("signed transaction mismatch"); }
  const entry: JournalEntry = { id: intent.id, intentHash, transactionHash: keccak256(raw), nonce: intent.nonce, reserved, status: "pending" };
  journal.entries.push(entry);
  // A durable pending hash survives a lost RPC response; never blindly retry it.
  await context.persist(journal);
  try {
    if (await context.broadcast(raw) !== entry.transactionHash) throw new Error("hash mismatch");
  } catch {
    throw new Error("submission outcome unknown; reconcile the journaled transaction hash");
  }
  return entry;
}
