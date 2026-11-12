import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as namespace from "@tiered-spending-guard/security-core/pwa";
import type { PwaObserverRecord } from "@tiered-spending-guard/security-core/pwa";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
const comparable = ({
  observer: _observer,
  observedAt: _observedAt,
  recordHash: _recordHash,
  ...record
}: PwaObserverRecord) => core.canonicalSubmissionJson(record);

/** Publish complete read-only evidence before a submission may become terminal. */
export function persistPwaObservation(directory: string, record: PwaObserverRecord): string {
  const bytes = core.serializePwaObserverRecord(record);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${record.transactionHash.slice(2).toLowerCase()}.json`);
  const existing = () => {
    const previous = JSON.parse(readFileSync(path, "utf8")) as PwaObserverRecord;
    core.serializePwaObserverRecord(previous);
    if (comparable(previous) !== comparable(record))
      throw new Error("receipt observation conflicts with retained evidence");
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  if (existsSync(path)) existing();
  else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        existing();
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  const directoryFd = openSync(directory, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
  return path;
}
