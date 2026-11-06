import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeFunctionData, isAddress, parseAbi, type Account, type Address, type Hex } from "viem";
import type { LiveContext, LiveIntent, LiveJournal, LiveReceipt } from "./submission";
import { OFFICIAL_DEPLOYMENT_REGISTRY } from "../../src/config/deployments";

const SEPOLIA = 11155111;
const FACTORY_ABI = parseAbi(["function createSigner(uint256 x,uint256 y,uint176 verifiers) returns (address)"]);
const DAIMO_VERIFIER = BigInt(OFFICIAL_DEPLOYMENT_REGISTRY[SEPOLIA]!.passkeySignerVerifier.address!);
const PASSKEY_FACTORY = OFFICIAL_DEPLOYMENT_REGISTRY[SEPOLIA]!.passkeySignerFactory.address!;

export type RpcReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint; blockHash: Hex }>;
export type SepoliaRpc = Readonly<{
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Address }): Promise<number | bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  getTransactionReceipt(args: { hash: Hex }): Promise<RpcReceipt>;
  waitForTransactionReceipt(args: { hash: Hex; confirmations: number }): Promise<RpcReceipt>;
  estimateGas(args: { account: Address; to?: Address; data: Hex; value: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>>;
  getBlockNumber(): Promise<bigint>;
}>;

const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`live intent ${label} must be a decimal string`);
  return BigInt(value);
};

export function decodeLiveIntent(serialized: string): LiveIntent {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("live intent must be JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("live intent must be an object");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  const expected = ["data", "gas", "id", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "to", "value"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("live intent has unexpected fields");
  if (typeof raw.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(raw.id) || typeof raw.to !== "string" || !isAddress(raw.to) || typeof raw.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data) || !Number.isSafeInteger(raw.nonce) || (raw.nonce as number) < 0) throw new Error("live intent is malformed");
  const intent: LiveIntent = Object.freeze({
    id: raw.id,
    to: raw.to as Address,
    data: raw.data.toLowerCase() as Hex,
    value: decimal(raw.value, "value"),
    nonce: raw.nonce as number,
    gas: decimal(raw.gas, "gas"),
    maxFeePerGas: decimal(raw.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: decimal(raw.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
  });
  if (intent.gas === 0n || intent.maxFeePerGas === 0n || intent.maxPriorityFeePerGas > intent.maxFeePerGas) throw new Error("live intent fee bounds are invalid");
  return intent;
}

/** Restricts the bootstrap runner to one harmless probe or exact factory calls for local credentials. */
export function verifyBootstrapIntent(
  intent: LiveIntent,
  funder: Address,
  credentials: Readonly<{ primary: Readonly<{ x: bigint; y: bigint }>; secondary: Readonly<{ x: bigint; y: bigint }> }>,
): void {
  if (intent.id === "probe-self") {
    if (intent.to?.toLowerCase() === funder.toLowerCase() && intent.value === 0n && intent.data === "0x") return;
    throw new Error("bootstrap intent probe mismatch");
  }
  const credential = intent.id === "primary-passkey-bootstrap" ? credentials.primary : intent.id === "secondary-passkey-bootstrap" ? credentials.secondary : undefined;
  if (!credential || intent.to?.toLowerCase() !== PASSKEY_FACTORY.toLowerCase() || intent.value !== 0n) throw new Error("bootstrap intent is not permitted");
  try {
    const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: intent.data });
    if (decoded.functionName !== "createSigner") throw new Error("selector");
    const [x, y, verifiers] = decoded.args;
    if (x !== credential.x || y !== credential.y || verifiers !== DAIMO_VERIFIER) throw new Error("arguments");
  } catch { throw new Error("bootstrap intent does not match local credential"); }
}

function decodeJournal(serialized: string, funder: Address): LiveJournal {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("live journal malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("live journal malformed");
  const raw = value as Record<string, unknown>;
  if (raw.chainId !== SEPOLIA || typeof raw.funder !== "string" || !isAddress(raw.funder) || raw.funder.toLowerCase() !== funder.toLowerCase() || !Array.isArray(raw.entries)) throw new Error("live journal identity mismatch");
  const entries = raw.entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("live journal entry malformed");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.intentHash !== "string" || typeof item.transactionHash !== "string" || !Number.isSafeInteger(item.nonce) || typeof item.reserved !== "string" || !/^(pending|success|reverted)$/.test(String(item.status))) throw new Error("live journal entry malformed");
    let receipt: LiveReceipt | undefined;
    if (item.receipt !== undefined) {
      if (!item.receipt || typeof item.receipt !== "object" || Array.isArray(item.receipt)) throw new Error("live journal receipt malformed");
      const rawReceipt = item.receipt as Record<string, unknown>;
      if (typeof rawReceipt.transactionHash !== "string" || rawReceipt.transactionHash !== item.transactionHash || (rawReceipt.status !== "success" && rawReceipt.status !== "reverted") || typeof rawReceipt.gasUsed !== "string" || typeof rawReceipt.effectiveGasPrice !== "string" || typeof rawReceipt.blockNumber !== "string" || typeof rawReceipt.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(rawReceipt.blockHash)) throw new Error("live journal receipt malformed");
      receipt = { transactionHash: rawReceipt.transactionHash as Hex, status: rawReceipt.status, gasUsed: decimal(rawReceipt.gasUsed, "receipt gasUsed"), effectiveGasPrice: decimal(rawReceipt.effectiveGasPrice, "receipt effectiveGasPrice"), blockNumber: decimal(rawReceipt.blockNumber, "receipt blockNumber"), blockHash: rawReceipt.blockHash as Hex };
    }
    return { id: item.id, intentHash: item.intentHash as Hex, transactionHash: item.transactionHash as Hex, nonce: item.nonce as number, reserved: decimal(item.reserved, "journal reservation"), status: item.status as "pending" | "success" | "reverted", receipt };
  });
  return { chainId: SEPOLIA, funder, entries };
}

export type LiveJournalStore = Readonly<{ load(): LiveJournal; save(journal: LiveJournal): void; close(): void }>;

export function readLiveJournal(path: string, funder: Address): LiveJournal {
  return existsSync(path) ? decodeJournal(readFileSync(path, "utf8"), funder) : { chainId: SEPOLIA, funder, entries: [] };
}

type PidLockIdentity = Readonly<{ dev: number; ino: number; links: number; contents: string; pid: number }>;

function localPid(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid local writer PID");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) throw new Error("invalid local writer PID");
  return pid;
}

function pidLockIdentity(path: string): PidLockIdentity {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > 12 || (process.getuid && stat.uid !== process.getuid())) throw new Error("unknown local writer lock identity");
    const contents = readFileSync(fd, "utf8");
    if (!/^[1-9][0-9]*\n$/.test(contents)) throw new Error("malformed local writer lock");
    return { dev: stat.dev, ino: stat.ino, links: stat.nlink, contents, pid: localPid(contents.slice(0, -1)) };
  } finally { closeSync(fd); }
}

function samePidLock(left: PidLockIdentity, right: PidLockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.contents === right.contents;
}

function provedDeadLocalPid(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function createPidLock(path: string): number {
  const fd = openSync(path, "wx", 0o600);
  const created = fstatSync(fd);
  try { writeFileSync(fd, `${process.pid}\n`, "utf8"); fsyncSync(fd); return fd; }
  catch (error) {
    // No lease escaped. Retain the fd (and inode) until removing only our own
    // partial file; never remove a path replaced during failed initialization.
    try {
      const current = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = fstatSync(current); if (stat.dev === created.dev && stat.ino === created.ino) unlinkSync(path); }
      finally { closeSync(current); }
    } catch { /* Unknown cleanup failure remains closed for manual inspection. */ }
    closeSync(fd);
    throw error;
  }
}

function recoverDeadPidLock(path: string): number {
  const original = pidLockIdentity(path);
  if (!provedDeadLocalPid(original.pid)) throw new Error("writer is active or unknown");
  const prefix = `${basename(path)}.recovery.`;
  // Claims have unique, never-reused names. Removing a dead claim cannot remove
  // the canonical lock or a newer writer's file, even when cleanup races.
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const match = /^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(suffix);
    if (!match || !provedDeadLocalPid(localPid(match[1]!))) continue;
    const claim = join(dirname(path), name);
    try {
      if (samePidLock(original, pidLockIdentity(claim)) && samePidLock(original, pidLockIdentity(claim))) unlinkSync(claim);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const claim = `${path}.recovery.${process.pid}.${randomUUID()}`;
  linkSync(path, claim);
  try {
    const candidate = pidLockIdentity(claim);
    // Canonical path + this claim must be the only links. While this claim
    // remains, another contender sees >=3 links, or sees no canonical inode
    // after removal. It therefore cannot unlink a replacement writer's lock.
    if (!samePidLock(original, candidate) || candidate.links !== 2 || !samePidLock(original, pidLockIdentity(path)) || !provedDeadLocalPid(original.pid) || !samePidLock(original, pidLockIdentity(path))) throw new Error("writer lock recovery is contended or changed");
    unlinkSync(path);
    return createPidLock(path);
  } finally { unlinkSync(claim); }
}

/** Synchronous local PID lease; unknown/live owners are never evicted. */
export function acquireLocalWriterLease(lockPath: string): Readonly<{ close(): void }> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = createPidLock(lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("local writer lock unavailable");
    try { fd = recoverDeadPidLock(lockPath); } catch { throw new Error("local writer lock unavailable"); }
  }
  const held = fstatSync(fd);
  let closed = false;
  return Object.freeze({ close() {
    if (closed) return;
    try {
      const current = pidLockIdentity(lockPath);
      if (current.dev !== held.dev || current.ino !== held.ino || current.contents !== `${process.pid}\n`) throw new Error("local writer lock ownership changed");
      unlinkSync(lockPath);
    } finally { closed = true; closeSync(fd); }
  } });
}

export function createLiveJournalStore(path: string, funder: Address): LiveJournalStore {
  const lease = acquireLocalWriterLease(`${path}.lock`);
  let closed = false;
  const load = (): LiveJournal => readLiveJournal(path, funder);
  const save = (journal: LiveJournal): void => {
    if (closed) throw new Error("live journal writer lock is closed");
    if (journal.chainId !== SEPOLIA || journal.funder.toLowerCase() !== funder.toLowerCase()) throw new Error("live journal identity mismatch");
    const temporary = `${path}.${process.pid}.tmp`;
    const encoded = JSON.stringify(journal, (_, value) => typeof value === "bigint" ? value.toString() : value) + "\n";
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, encoded, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    lease.close();
  };
  return Object.freeze({ load, save, close });
}

export async function withLiveJournalStore<T>(path: string, funder: Address, callback: (store: LiveJournalStore) => Promise<T>): Promise<T> {
  const store = createLiveJournalStore(path, funder);
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

export function createSepoliaLiveContext(input: Readonly<{ account: Account; client: SepoliaRpc; verify(): Promise<void>; persist(journal: LiveJournal): Promise<void> }>): LiveContext {
  const funder = input.account.address;
  const signTransaction = input.account.signTransaction;
  if (!signTransaction) throw new Error("live account cannot sign transactions");
  return Object.freeze({
    funder,
    chainId: () => input.client.getChainId(),
    nonce: async () => Number(await input.client.getTransactionCount({ address: funder })),
    balance: () => input.client.getBalance({ address: funder }),
    verify: input.verify,
    sign: (intent) => signTransaction({ chainId: SEPOLIA, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }),
    broadcast: async (raw) => input.client.sendRawTransaction({ serializedTransaction: raw }),
    receipt: async (hash): Promise<LiveReceipt | undefined> => {
      try { return await input.client.waitForTransactionReceipt({ hash, confirmations: 6 }); } catch { return undefined; }
    },
    persist: input.persist,
  });
}
