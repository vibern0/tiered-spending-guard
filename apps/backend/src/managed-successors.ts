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
import { dirname } from "node:path";
import type { Address } from "viem";
import * as namespace from "@recent-tx-safe-guard/security-core/pwa";
import type { PwaProvisioningSuccessor } from "@recent-tx-safe-guard/security-core/pwa";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
type Ledger = {
  formatVersion: 1;
  chainId: 11155111;
  deployer: Address;
  records: readonly PwaProvisioningSuccessor[];
};
const canonical = core.canonicalSubmissionJson;

function read(path: string, deployer: Address): Ledger {
  if (!existsSync(path)) return { formatVersion: 1, chainId: 11155111, deployer, records: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.keys(raw).sort().join() !== "chainId,deployer,formatVersion,records" ||
    raw.formatVersion !== 1 ||
    raw.chainId !== 11155111 ||
    typeof raw.deployer !== "string" ||
    raw.deployer.toLowerCase() !== deployer.toLowerCase() ||
    !Array.isArray(raw.records) ||
    raw.records.length > 64
  )
    throw new Error("managed successor ledger identity is invalid");
  return {
    formatVersion: 1,
    chainId: 11155111,
    deployer,
    records: raw.records.map(core.loadPwaProvisioningSuccessor),
  };
}

function active(records: readonly PwaProvisioningSuccessor[]): readonly PwaProvisioningSuccessor[] {
  const latest = new Map<string, PwaProvisioningSuccessor>();
  for (const candidate of records) {
    const prior = latest.get(candidate.originalPackageHash);
    if (
      prior &&
      (prior.confirmedPrefixLength !== candidate.confirmedPrefixLength ||
        candidate.consumedTransactions.length <= prior.consumedTransactions.length ||
        canonical(candidate.consumedTransactions.slice(0, prior.consumedTransactions.length)) !==
          canonical(prior.consumedTransactions))
    )
      throw new Error("managed successor lineage is conflicting or regressed");
    latest.set(candidate.originalPackageHash, candidate);
  }
  return Object.freeze([...latest.values()]);
}

export function mergePwaSuccessors(
  committed: readonly PwaProvisioningSuccessor[],
  managed: readonly PwaProvisioningSuccessor[],
): readonly PwaProvisioningSuccessor[] {
  const exact = new Map<string, PwaProvisioningSuccessor>();
  for (const candidate of [...committed, ...managed]) exact.set(canonical(candidate), candidate);
  return active([...exact.values()]);
}

/** Public hints only: the core independently verifies every returned lineage. */
export function loadManagedPwaSuccessors(
  journalPath: string,
  deployer: Address,
): readonly PwaProvisioningSuccessor[] {
  return active(read(`${journalPath}.successors.json`, deployer).records);
}

/** Append only after the complete core recovery verifier accepted this candidate. */
export function appendManagedPwaSuccessor(
  journalPath: string,
  deployer: Address,
  candidate: PwaProvisioningSuccessor,
): void {
  const path = `${journalPath}.successors.json`;
  const lease = core.acquireLocalWriterLease(`${path}.lock`);
  try {
    const ledger = read(path, deployer);
    const checked = core.loadPwaProvisioningSuccessor(JSON.parse(canonical(candidate)));
    if (ledger.records.some((previous) => canonical(previous) === canonical(checked))) return;
    const next = { ...ledger, records: [...ledger.records, checked] };
    if (next.records.length > 64)
      throw new Error("managed successor lineage exceeds its supported bound");
    active(next.records);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, `${canonical(next)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  } finally {
    lease.close();
  }
}
