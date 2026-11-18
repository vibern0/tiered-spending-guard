import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import { hydrateActivityAlert, publicAlertPayloadHash, type ActivityAlert, type WebhookDeliveryEvidence } from "./notifier";

export type ActivityLogKey = Readonly<{ chainId: number; blockHash: Hex; transactionHash: Hex; logIndex: number }>;
export type LedgerCursor = Readonly<{ blockNumber: bigint; blockHash: Hex; logIndex: number }>;
export type OutboxEntry = Readonly<{ key: ActivityLogKey; alert: ActivityAlert }>;
export type LedgerState = { cursor?: LedgerCursor; records: Record<string, ActivityAlert>; outbox: Record<string, ActivityAlert>; deliveries: Record<string, WebhookDeliveryEvidence> };
export interface ActivityStore { load(): LedgerState; save(state: LedgerState): void; close?(): void; }

export class InMemoryActivityStore implements ActivityStore {
  private state: LedgerState = { records: {}, outbox: {}, deliveries: {} };
  load(): LedgerState { return this.state; }
  save(state: LedgerState): void { this.state = state; }
}

export class FileActivityStore implements ActivityStore {
  private readonly lockPath: string;
  private lockFd: number | undefined;
  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.lockFd = openSync(this.lockPath, "wx");
      writeFileSync(this.lockFd, `${process.pid}\n`, "utf8");
      fsyncSync(this.lockFd);
    } catch (error) {
      if (this.lockFd !== undefined) closeSync(this.lockFd);
      throw new Error(`monitor ledger writer lock unavailable: ${String(error)}`);
    }
  }
  load(): LedgerState {
    if (!existsSync(this.path)) return { records: {}, outbox: {}, deliveries: {} };
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>; }
    catch { throw new Error("malformed monitor ledger JSON"); }
    const objectMap = (value: unknown, name: string): Record<string, unknown> => {
      if (value === undefined) return {};
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`malformed monitor ledger ${name}`);
      return value as Record<string, unknown>;
    };
    const records: Record<string, ActivityAlert> = {};
    for (const [recordId, value] of Object.entries(objectMap(raw.records, "records"))) records[recordId] = hydrateActivityAlert(value);
    const outbox: Record<string, ActivityAlert> = {};
    const persistedOutbox = raw.outbox === undefined ? records : objectMap(raw.outbox, "outbox");
    for (const [recordId, value] of Object.entries(persistedOutbox)) outbox[recordId] = raw.outbox === undefined ? value as ActivityAlert : hydrateActivityAlert(value);
    for (const [recordId, alert] of Object.entries(outbox)) if (!records[recordId] || publicAlertPayloadHash(records[recordId]).toLowerCase() !== publicAlertPayloadHash(alert).toLowerCase()) throw new Error("malformed monitor ledger outbox binding");
    const deliveries: Record<string, WebhookDeliveryEvidence> = {};
    for (const [recordId, value] of Object.entries(objectMap(raw.deliveries, "deliveries"))) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed delivery evidence");
      const evidence = value as Record<string, unknown>;
      if (evidence.channel !== "webhook" || typeof evidence.httpStatus !== "number" || !Number.isSafeInteger(evidence.httpStatus) || evidence.httpStatus < 200 || evidence.httpStatus >= 300 || typeof evidence.payloadHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(evidence.payloadHash) || typeof evidence.deliveredAt !== "string" || Number.isNaN(Date.parse(evidence.deliveredAt))) throw new Error("malformed delivery evidence");
      deliveries[recordId] = evidence as unknown as WebhookDeliveryEvidence;
    }
    for (const [recordId, evidence] of Object.entries(deliveries)) {
      if (!records[recordId] || publicAlertPayloadHash(records[recordId]).toLowerCase() !== evidence.payloadHash.toLowerCase()) throw new Error("delivery evidence payload mismatch");
      if (outbox[recordId]) throw new Error("malformed monitor ledger delivered outbox entry");
    }
    let cursor: LedgerCursor | undefined;
    if (raw.cursor !== undefined) {
      if (!raw.cursor || typeof raw.cursor !== "object" || Array.isArray(raw.cursor)) throw new Error("malformed monitor ledger cursor");
      const value = raw.cursor as Record<string, unknown>;
      if (typeof value.blockNumber !== "string" || !/^\d+$/.test(value.blockNumber) || typeof value.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash) || typeof value.logIndex !== "number" || !Number.isSafeInteger(value.logIndex) || value.logIndex < 0) throw new Error("malformed monitor ledger cursor");
      cursor = { blockNumber: BigInt(value.blockNumber), blockHash: value.blockHash as Hex, logIndex: value.logIndex };
    }
    return { cursor, records, outbox, deliveries };
  }
  save(state: LedgerState): void {
    if (this.lockFd === undefined) throw new Error("monitor ledger writer lock is closed");
    const temp = `${this.path}.${process.pid}.tmp`;
    const encoded = JSON.stringify(state, (_, value) => typeof value === "bigint" ? value.toString() : value) + "\n";
    const fd = openSync(temp, "w");
    try { writeFileSync(fd, encoded, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dirFd = openSync(dirname(this.path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
  close(): void {
    if (this.lockFd === undefined) return;
    closeSync(this.lockFd);
    this.lockFd = undefined;
    unlinkSync(this.lockPath);
  }
}

const id = (key: ActivityLogKey): string => `${key.chainId}:${key.transactionHash.toLowerCase()}:${key.logIndex}:${key.blockHash.toLowerCase()}`;

export class ActivityLedger {
  private state: LedgerState;
  constructor(private readonly store: ActivityStore) { this.state = store.load(); }
  cursor(): LedgerCursor | undefined { return this.state.cursor; }
  accept(key: ActivityLogKey, alert: ActivityAlert): boolean {
    hydrateActivityAlert(JSON.parse(JSON.stringify(alert, (_, value) => typeof value === "bigint" ? value.toString() : value)));
    const recordId = id(key);
    if (this.state.records[recordId]) return false;
    this.state.records[recordId] = alert;
    this.state.outbox[recordId] = alert;
    const cursor = this.state.cursor;
    if (!cursor || alert.blockNumber > cursor.blockNumber || (alert.blockNumber === cursor.blockNumber && key.logIndex > cursor.logIndex)) this.state.cursor = { blockNumber: alert.blockNumber, blockHash: key.blockHash, logIndex: key.logIndex };
    this.store.save(this.state);
    return true;
  }
  pending(): readonly OutboxEntry[] {
    return Object.entries(this.state.outbox).map(([recordId, alert]) => {
      const [chainId, transactionHash, logIndex, blockHash] = recordId.split(":");
      return { key: { chainId: Number(chainId), transactionHash: transactionHash as Hex, logIndex: Number(logIndex), blockHash: blockHash as Hex }, alert };
    });
  }
  payloadHash(alert: ActivityAlert): Hex { return publicAlertPayloadHash(alert); }
  delivery(key: ActivityLogKey): WebhookDeliveryEvidence | undefined { return this.state.deliveries[id(key)]; }
  markDelivered(key: ActivityLogKey, evidence: WebhookDeliveryEvidence): void { const recordId = id(key); const pending = this.state.outbox[recordId]; if (!pending) return; if (!evidence || evidence.channel !== "webhook") throw new Error("webhook delivery evidence required"); if (evidence.payloadHash.toLowerCase() !== publicAlertPayloadHash(pending).toLowerCase()) throw new Error("delivery evidence payload mismatch"); if (!Number.isSafeInteger(evidence.httpStatus) || evidence.httpStatus < 200 || evidence.httpStatus >= 300 || Number.isNaN(Date.parse(evidence.deliveredAt))) throw new Error("invalid delivery evidence"); this.state.deliveries[recordId] = evidence; delete this.state.outbox[recordId]; this.store.save(this.state); }
  private rewindCursor(): void { let next: LedgerCursor | undefined; for (const [recordId, alert] of Object.entries(this.state.records)) { const parts = recordId.split(":"); const candidate = { blockNumber: alert.blockNumber, blockHash: parts[parts.length - 1] as Hex, logIndex: Number(parts[2]) }; if (!next || candidate.blockNumber > next.blockNumber || (candidate.blockNumber === next.blockNumber && candidate.logIndex > next.logIndex)) next = candidate; } this.state.cursor = next; }
  remove(key: ActivityLogKey): ActivityAlert | undefined { const recordId = id(key); const previous = this.state.records[recordId]; if (!previous) return undefined; delete this.state.records[recordId]; delete this.state.outbox[recordId]; delete this.state.deliveries[recordId]; this.rewindCursor(); this.store.save(this.state); return previous; }
  reconcileCanonical(chainId: number, canonical: (block: number) => Hex | undefined): number { let removed = 0; for (const [recordId, alert] of Object.entries(this.state.records)) { if (alert.chainId !== chainId) continue; const hash = canonical(Number(alert.blockNumber)); if (hash && hash.toLowerCase() !== recordId.slice(recordId.lastIndexOf(":") + 1).toLowerCase()) { delete this.state.records[recordId]; delete this.state.outbox[recordId]; delete this.state.deliveries[recordId]; removed++; } } if (removed) { this.rewindCursor(); this.store.save(this.state); } return removed; }
  records(): readonly ActivityAlert[] { return Object.values(this.state.records); }
}
