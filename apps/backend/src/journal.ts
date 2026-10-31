import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type SubmissionState =
  | "prepared"
  | "awaiting-primary"
  | "awaiting-secondary"
  | "submitting"
  | "uncertain"
  | "confirmed"
  | "reverted"
  | "superseded";
export type PublicReceipt = Readonly<{
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
}>;
export type JournalEntry = Readonly<{
  id: string;
  requestHash: string;
  publicRequest: Readonly<Record<string, unknown>>;
  state: SubmissionState;
  approvals: Readonly<{ primary: boolean; secondary: boolean }>;
  outerTransactionHash?: string;
  receipt?: PublicReceipt;
}>;
export type Reconciliation = Readonly<{
  status: "confirmed" | "reverted";
  transactionHash: string;
  blockNumber?: bigint;
  blockHash?: string;
}>;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const rank: Record<SubmissionState, number> = {
  prepared: 0,
  "awaiting-primary": 1,
  "awaiting-secondary": 2,
  submitting: 3,
  uncertain: 4,
  confirmed: 5,
  reverted: 5,
  superseded: 5,
};
const sensitive =
  /assertion|signature|credential|private|secret|mnemonic|seed|pin|rpc|provider/i;

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value))
    throw new Error(`${label} is invalid`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error(`${label} contains an unsupported field`);
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        if (sensitive.test(key))
          throw new Error(
            `public journal request contains sensitive field: ${key}`,
          );
        output[key] = visit((item as Record<string, unknown>)[key]);
      }
      return output;
    }
    return item;
  };
  return JSON.stringify(visit(value));
}

function publicRequest(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("public request must be an object");
  return deepFreeze(JSON.parse(canonical(value))) as Readonly<
    Record<string, unknown>
  >;
}

export class SubmissionJournal {
  private readonly entries = new Map<string, JournalEntry>();
  private readonly path?: string;

  constructor(storagePath?: string) {
    if (storagePath !== undefined) {
      if (!isAbsolute(storagePath))
        throw new Error("journal path must be absolute");
      const root = resolve(process.cwd());
      if (!relative(root, storagePath).startsWith(".."))
        throw new Error("journal must be outside the repository");
      this.path = storagePath;
      mkdirSync(dirname(storagePath), { recursive: true, mode: 0o700 });
      if (existsSync(storagePath)) this.load();
    }
  }

  prepare(
    id: string,
    requestHash: string,
    request: Readonly<Record<string, unknown>> = {},
  ): JournalEntry {
    assertIdentifier(id, "submission ID");
    this.assertHash(requestHash);
    const frozenRequest = publicRequest(request);
    const existing = this.entries.get(id);
    if (existing) {
      if (
        existing.requestHash.toLowerCase() !== requestHash.toLowerCase() ||
        canonical(existing.publicRequest) !== canonical(frozenRequest)
      )
        throw new Error("submission ID is already bound to another request");
      return existing;
    }
    return this.set(
      Object.freeze({
        id,
        requestHash,
        publicRequest: frozenRequest,
        state: "prepared" as const,
        approvals: Object.freeze({ primary: false, secondary: false }),
      }),
    );
  }

  transition(id: string, state: SubmissionState): JournalEntry {
    const entry = this.require(id);
    if (rank[entry.state] === 5)
      throw new Error(
        `terminal submission cannot transition from ${entry.state}`,
      );
    if (
      rank[state] < rank[entry.state] ||
      (state === "uncertain" && entry.state !== "submitting")
    )
      throw new Error(
        `invalid submission transition from ${entry.state} to ${state}`,
      );
    return state === entry.state
      ? entry
      : this.set(Object.freeze({ ...entry, state }));
  }

  recordApproval(
    id: string,
    role: "primary" | "secondary",
    approvalHash: string,
  ): JournalEntry {
    this.assertHash(approvalHash);
    const entry = this.require(id);
    if (rank[entry.state] >= rank.submitting)
      throw new Error("submission no longer accepts approvals");
    if (role === "secondary" && !entry.approvals.primary)
      throw new Error("primary approval is required before secondary approval");
    const approvals = Object.freeze({ ...entry.approvals, [role]: true });
    return this.set(
      Object.freeze({
        ...entry,
        approvals,
        state:
          role === "primary" ? ("awaiting-secondary" as const) : entry.state,
      }),
    );
  }

  markSubmitting(id: string, outerTransactionHash: string): JournalEntry {
    this.assertHash(outerTransactionHash);
    const entry = this.require(id);
    if (rank[entry.state] >= rank.submitting) {
      if (
        entry.outerTransactionHash?.toLowerCase() !==
        outerTransactionHash.toLowerCase()
      )
        throw new Error("submission outer hash changed");
      return entry;
    }
    return this.set(
      Object.freeze({
        ...entry,
        state: "submitting" as const,
        outerTransactionHash,
      }),
    );
  }

  markSubmitted(id: string, transactionHash: string): JournalEntry {
    return this.markSubmitting(id, transactionHash);
  }
  markUncertain(id: string): JournalEntry {
    if (this.require(id).state !== "submitting")
      throw new Error("only a submitting request can become uncertain");
    return this.transition(id, "uncertain");
  }

  reconcile(id: string, result: Reconciliation): JournalEntry {
    const entry = this.require(id);
    this.assertHash(result.transactionHash);
    if (rank[entry.state] === 5)
      throw new Error(
        `terminal submission cannot be reconciled from ${entry.state}`,
      );
    if (
      !entry.outerTransactionHash ||
      entry.outerTransactionHash.toLowerCase() !==
        result.transactionHash.toLowerCase()
    )
      throw new Error(
        "reconciliation hash does not match the durable outer hash",
      );
    if ((result.blockNumber === undefined) !== (result.blockHash === undefined))
      throw new Error("receipt block identity is incomplete");
    if (result.blockNumber !== undefined && result.blockNumber < 0n)
      throw new Error("receipt block number is invalid");
    if (result.blockHash !== undefined) this.assertHash(result.blockHash);
    const receipt =
      result.blockNumber === undefined || result.blockHash === undefined
        ? undefined
        : Object.freeze({
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            blockHash: result.blockHash,
          });
    return this.set(
      Object.freeze({
        ...entry,
        state: result.status,
        outerTransactionHash: result.transactionHash,
        ...(receipt ? { receipt } : {}),
      }),
    );
  }

  get(id: string): JournalEntry | undefined {
    return this.entries.get(id);
  }

  private require(id: string): JournalEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("unknown submission");
    return entry;
  }
  private assertHash(value: string): void {
    if (!HASH.test(value)) throw new Error("transaction hash is invalid");
  }
  private set(entry: JournalEntry): JournalEntry {
    this.entries.set(entry.id, entry);
    this.persist();
    return entry;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path!, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("journal is malformed");
      for (const item of parsed) {
        if (!item || typeof item !== "object")
          throw new Error("journal entry is malformed");
        const raw = item as Record<string, unknown>;
        assertExactKeys(
          raw,
          [
            "id",
            "requestHash",
            "publicRequest",
            "state",
            "approvals",
            "outerTransactionHash",
            "receipt",
          ],
          "journal entry",
        );
        assertIdentifier(String(raw.id), "journal entry ID");
        this.assertHash(String(raw.requestHash));
        if (!Object.hasOwn(rank, String(raw.state)))
          throw new Error("journal state is invalid");
        const approvals = raw.approvals as Record<string, unknown>;
        if (
          !approvals ||
          typeof approvals.primary !== "boolean" ||
          typeof approvals.secondary !== "boolean"
        )
          throw new Error("journal approvals are invalid");
        assertExactKeys(
          approvals,
          ["primary", "secondary"],
          "journal approvals",
        );
        if (approvals.secondary && !approvals.primary)
          throw new Error("journal approval order is invalid");
        const receiptRaw = raw.receipt as Record<string, unknown> | undefined;
        if (receiptRaw)
          assertExactKeys(
            receiptRaw,
            ["transactionHash", "blockNumber", "blockHash"],
            "journal receipt",
          );
        const receipt = receiptRaw
          ? Object.freeze({
              transactionHash: String(receiptRaw.transactionHash),
              blockNumber: BigInt(String(receiptRaw.blockNumber)),
              blockHash: String(receiptRaw.blockHash),
            })
          : undefined;
        const entry = Object.freeze({
          id: String(raw.id),
          requestHash: String(raw.requestHash),
          publicRequest: publicRequest(raw.publicRequest),
          state: String(raw.state) as SubmissionState,
          approvals: Object.freeze({
            primary: approvals.primary,
            secondary: approvals.secondary,
          }),
          ...(raw.outerTransactionHash
            ? { outerTransactionHash: String(raw.outerTransactionHash) }
            : {}),
          ...(receipt ? { receipt } : {}),
        });
        if (entry.outerTransactionHash)
          this.assertHash(entry.outerTransactionHash);
        if (
          ["submitting", "uncertain", "confirmed", "reverted"].includes(
            entry.state,
          ) &&
          !entry.outerTransactionHash
        )
          throw new Error("journal outer transaction hash is missing");
        if (rank[entry.state] < rank.submitting && entry.outerTransactionHash)
          throw new Error("journal outer transaction hash is premature");
        if (entry.state === "awaiting-secondary" && !entry.approvals.primary)
          throw new Error("journal primary approval is missing");
        if (entry.receipt) {
          this.assertHash(entry.receipt.transactionHash);
          this.assertHash(entry.receipt.blockHash);
          if (
            entry.receipt.blockNumber < 0n ||
            (entry.state !== "confirmed" && entry.state !== "reverted")
          )
            throw new Error("journal receipt state is invalid");
          if (
            entry.receipt.transactionHash.toLowerCase() !==
            entry.outerTransactionHash?.toLowerCase()
          )
            throw new Error(
              "journal receipt hash does not match the outer transaction hash",
            );
        }
        if (this.entries.has(entry.id))
          throw new Error("journal contains a duplicate submission ID");
        this.entries.set(entry.id, entry);
      }
    } catch {
      throw new Error("journal could not be loaded safely");
    }
  }

  private persist(): void {
    if (!this.path) return;
    const temporary = `${this.path}.tmp`;
    const serialized = JSON.stringify(
      [...this.entries.values()],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    writeFileSync(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}
