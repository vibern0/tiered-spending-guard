import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAddress, type Address, type Hex } from "viem";
import { pwaProvisioningAuthorizationHash, type PwaProvisioningTransactionAuthorization } from "./authorization";

export type PwaProvisioningAuthorizationStoreIdentity = Readonly<{
  chainId: 11155111;
  deployer: Address;
  packageHash: Hex;
  planHash: Hex;
}>;

export type PwaProvisioningAuthorizationLedger = Readonly<PwaProvisioningAuthorizationStoreIdentity & {
  formatVersion: 1;
  records: readonly PwaProvisioningTransactionAuthorization[];
}>;

export type PwaProvisioningAuthorizationStore = Readonly<{
  load(): PwaProvisioningAuthorizationLedger;
  append(record: PwaProvisioningTransactionAuthorization): void;
  close(): void;
}>;

const HASH = /^0x[0-9a-fA-F]{64}$/;

function decodeRecord(value: unknown): PwaProvisioningTransactionAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provisioning authorization record is malformed");
  const input = value as Record<string, unknown>;
  if (typeof input.authorizationHash !== "string" || !HASH.test(input.authorizationHash)) throw new Error("provisioning authorization record hash is malformed");
  const { authorizationHash, ...payload } = input;
  if (pwaProvisioningAuthorizationHash(payload as Omit<PwaProvisioningTransactionAuthorization, "authorizationHash">) !== authorizationHash.toLowerCase()) throw new Error("provisioning authorization record hash mismatch");
  return Object.freeze({ ...input, authorizationHash: authorizationHash.toLowerCase() }) as unknown as PwaProvisioningTransactionAuthorization;
}

function decodeLedger(serialized: string, identity: PwaProvisioningAuthorizationStoreIdentity): PwaProvisioningAuthorizationLedger {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("provisioning authorization sidecar is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provisioning authorization sidecar is malformed");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["chainId", "deployer", "formatVersion", "packageHash", "planHash", "records"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("provisioning authorization sidecar is malformed");
  if (
    input.formatVersion !== 1
    || input.chainId !== identity.chainId
    || typeof input.deployer !== "string"
    || !isAddress(input.deployer)
    || input.deployer.toLowerCase() !== identity.deployer.toLowerCase()
    || input.packageHash !== identity.packageHash
    || input.planHash !== identity.planHash
  ) throw new Error("provisioning authorization sidecar identity mismatch");
  if (!Array.isArray(input.records)) throw new Error("provisioning authorization sidecar records are malformed");
  const records = Object.freeze(input.records.map(decodeRecord));
  if (new Set(records.map((record) => record.authorizationHash)).size !== records.length) throw new Error("provisioning authorization sidecar contains duplicate records");
  return Object.freeze({ formatVersion: 1, ...identity, records });
}

export function createPwaProvisioningAuthorizationStore(path: string, identity: PwaProvisioningAuthorizationStoreIdentity): PwaProvisioningAuthorizationStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    fsyncSync(lock);
  } catch { throw new Error("provisioning authorization sidecar lock unavailable"); }

  const write = (ledger: PwaProvisioningAuthorizationLedger): void => {
    if (lock === undefined) throw new Error("provisioning authorization sidecar is closed");
    const temporary = `${path}.${process.pid}.tmp`;
    const output = `${JSON.stringify(ledger)}\n`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, output, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const empty = Object.freeze({ formatVersion: 1 as const, ...identity, records: Object.freeze([]) });
  try {
    if (!existsSync(path)) write(empty);
    else decodeLedger(readFileSync(path, "utf8"), identity);
  } catch (error) {
    closeSync(lock);
    lock = undefined;
    unlinkSync(lockPath);
    throw error;
  }

  const load = (): PwaProvisioningAuthorizationLedger => decodeLedger(readFileSync(path, "utf8"), identity);
  const append = (record: PwaProvisioningTransactionAuthorization): void => {
    const current = load();
    const decoded = decodeRecord(record);
    if (decoded.packageHash !== identity.packageHash || decoded.planHash !== identity.planHash) throw new Error("provisioning authorization record identity mismatch");
    if (current.records.some((item) => item.authorizationHash === decoded.authorizationHash)) throw new Error("duplicate provisioning authorization record");
    write(Object.freeze({ ...current, records: Object.freeze([...current.records, decoded]) }));
  };
  const close = (): void => {
    if (lock === undefined) return;
    closeSync(lock);
    lock = undefined;
    unlinkSync(lockPath);
  };
  return Object.freeze({ load, append, close });
}
