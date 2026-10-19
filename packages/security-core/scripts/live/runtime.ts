import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeFunctionData, isAddress, parseAbi, type Account, type Address, type Hex } from "viem";
import type { LiveContext, LiveIntent, LiveJournal, LiveReceipt } from "./submission";
import { OFFICIAL_DEPLOYMENT_REGISTRY } from "../../src/config/deployments";

const SEPOLIA = 11155111;
const FACTORY_ABI = parseAbi(["function createSigner(uint256 x,uint256 y,uint176 verifiers) returns (address)"]);
const DAIMO_VERIFIER = BigInt(OFFICIAL_DEPLOYMENT_REGISTRY[SEPOLIA]!.passkeySignerVerifier.address!);
const PASSKEY_FACTORY = OFFICIAL_DEPLOYMENT_REGISTRY[SEPOLIA]!.passkeySignerFactory.address!;

type RpcReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint; blockHash: Hex }>;
export type SepoliaRpc = Readonly<{
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Address }): Promise<number | bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  getTransactionReceipt(args: { hash: Hex }): Promise<RpcReceipt>;
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

export function createLiveJournalStore(path: string, funder: Address): LiveJournalStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    fsyncSync(lock);
  } catch { throw new Error("live journal writer lock unavailable"); }
  const load = (): LiveJournal => readLiveJournal(path, funder);
  const save = (journal: LiveJournal): void => {
    if (lock === undefined) throw new Error("live journal writer lock is closed");
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
    if (lock === undefined) return;
    closeSync(lock);
    lock = undefined;
    unlinkSync(lockPath);
  };
  return Object.freeze({ load, save, close });
}

export function createSepoliaLiveContext(input: Readonly<{ account: Account; client: SepoliaRpc; verify(): Promise<void>; persist(journal: LiveJournal): Promise<void> }>): LiveContext {
  const funder = input.account.address;
  return Object.freeze({
    funder,
    chainId: () => input.client.getChainId(),
    nonce: async () => Number(await input.client.getTransactionCount({ address: funder })),
    balance: () => input.client.getBalance({ address: funder }),
    verify: input.verify,
    sign: (intent) => input.account.signTransaction({ chainId: SEPOLIA, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }),
    broadcast: async (raw) => input.client.sendRawTransaction({ serializedTransaction: raw }),
    receipt: async (hash): Promise<LiveReceipt | undefined> => {
      try { return await input.client.getTransactionReceipt({ hash }); } catch { return undefined; }
    },
    persist: input.persist,
  });
}
