import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as pwaNamespace from "@recent-tx-safe-guard/security-core/pwa";

const pwaRuntime = (pwaNamespace as unknown as { default?: typeof pwaNamespace }).default ?? pwaNamespace;

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
  private entries = new Map<string, JournalEntry>();
  private readonly path?: string;
  private mutating = false;

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

  /** Publish an empty durable submission ledger before publishing an account. */
  ensurePersisted(): void { this.mutate(() => { if (this.path && !existsSync(this.path)) this.persist(); }); }

  prepare(
    id: string,
    requestHash: string,
    request: Readonly<Record<string, unknown>> = {},
  ): JournalEntry {
    return this.mutate(() => this.prepareEntry(id, requestHash, request));
  }

  private prepareEntry(id: string, requestHash: string, request: Readonly<Record<string, unknown>>): JournalEntry {
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
    return this.mutate(() => this.transitionEntry(id, state));
  }

  private transitionEntry(id: string, state: SubmissionState): JournalEntry {
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
    return this.mutate(() => this.recordApprovalEntry(id, role, approvalHash));
  }

  private recordApprovalEntry(id: string, role: "primary" | "secondary", approvalHash: string): JournalEntry {
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
    return this.mutate(() => this.markSubmittingEntry(id, outerTransactionHash));
  }

  private markSubmittingEntry(id: string, outerTransactionHash: string): JournalEntry {
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
    return this.mutate(() => {
      if (this.require(id).state !== "submitting")
        throw new Error("only a submitting request can become uncertain");
      return this.transition(id, "uncertain");
    });
  }

  reconcile(id: string, result: Reconciliation): JournalEntry {
    return this.mutate(() => this.reconcileEntry(id, result));
  }

  private reconcileEntry(id: string, result: Reconciliation): JournalEntry {
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
    this.refresh();
    return this.entries.get(id);
  }

  findByOuterHash(hash: string): JournalEntry | undefined {
    this.refresh();
    this.assertHash(hash);
    const matching = [...this.entries.values()].filter((entry) => entry.outerTransactionHash?.toLowerCase() === hash.toLowerCase());
    if (matching.length > 1) throw new Error("durable outer transaction hash is ambiguous");
    return matching[0];
  }

  /** Bounded recovery hints; all unresolved hashes stay visible after browser reset. */
  recoveryIds(): readonly string[] {
    this.refresh();
    const entries = [...this.entries.values()];
    const pending = entries.filter(e => e.state === "submitting" || e.state === "uncertain");
    const recent = entries.filter(e => e.state !== "submitting" && e.state !== "uncertain").slice(-20);
    return Object.freeze([...recent, ...pending].map(e => e.id));
  }

  listPending(): readonly JournalEntry[] {
    this.refresh();
    return Object.freeze([...this.entries.values()].filter(entry => entry.state === "submitting" || entry.state === "uncertain"));
  }

  private refresh(): void {
    if (!this.path || this.mutating) return;
    if (existsSync(this.path)) this.load();
    else if (this.entries.size > 0) throw new Error("submission journal disappeared; refusing to reset its evidence");
  }

  private mutate<T>(operation: () => T): T {
    if (!this.path || this.mutating) return operation();
    const lease = pwaRuntime.acquireLocalWriterLease(`${this.path}.lock`);
    try {
      this.refresh();
      const previous = new Map(this.entries);
      this.mutating = true;
      try { return operation(); }
      catch (error) { this.entries = previous; throw error; }
      finally { this.mutating = false; }
    } finally { lease.close(); }
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
      const loaded = new Map<string, JournalEntry>();
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
        if (loaded.has(entry.id))
          throw new Error("journal contains a duplicate submission ID");
        loaded.set(entry.id, entry);
      }
      this.entries = loaded;
    } catch {
      throw new Error("journal could not be loaded safely");
    }
  }

  private persist(): void {
    if (!this.path) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    const serialized = JSON.stringify(
      [...this.entries.values()],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    const fd = openSync(temporary, "wx", 0o600);
    let renamed = false;
    try {
      try { writeFileSync(fd, serialized, "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.path);
      renamed = true;
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); }
      finally { closeSync(directory); }
    } finally {
      if (!renamed) unlinkSync(temporary);
    }
  }
}
