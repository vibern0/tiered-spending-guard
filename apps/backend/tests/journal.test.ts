import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubmissionJournal } from "../src/journal";

const directories: string[] = [];
const HASH = `0x${"aa".repeat(32)}`;
const OUTER = `0x${"bb".repeat(32)}`;
const BLOCK = `0x${"cc".repeat(32)}`;

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("submission journal", () => {
  it("persists the monotonic lifecycle and public receipt without signatures", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-submission-journal-")); directories.push(directory);
    const path = join(directory, "journal.json");
    const journal = new SubmissionJournal(path);
    const request = { kind: "transfer", recipient: "0x1111111111111111111111111111111111111111", amount: "1000000" };

    expect(journal.prepare("request-1", HASH, request).state).toBe("prepared");
    expect(journal.transition("request-1", "awaiting-primary").state).toBe("awaiting-primary");
    expect(journal.recordApproval("request-1", "primary", HASH).state).toBe("awaiting-secondary");
    expect(journal.recordApproval("request-1", "secondary", OUTER).approvals).toEqual({ primary: true, secondary: true });
    expect(journal.markSubmitting("request-1", OUTER).state).toBe("submitting");
    expect(journal.markUncertain("request-1").state).toBe("uncertain");
    expect(journal.reconcile("request-1", { status: "confirmed", transactionHash: OUTER, blockNumber: 12n, blockHash: BLOCK }).state).toBe("confirmed");

    const restarted = new SubmissionJournal(path);
    expect(restarted.get("request-1")).toMatchObject({ state: "confirmed", requestHash: HASH, outerTransactionHash: OUTER, receipt: { blockNumber: 12n, blockHash: BLOCK } });
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toMatch(/assertion|signature|credential|private|secret/i);
  });

  it("deduplicates exact public requests and rejects byte or state rollback", () => {
    const journal = new SubmissionJournal();
    const request = { kind: "execute-ready", queueNonce: "3", queueFingerprint: HASH };
    expect(journal.prepare("request-1", HASH, request)).toBe(journal.prepare("request-1", HASH, request));
    expect(() => journal.prepare("request-1", OUTER, request)).toThrow(/another request/i);
    expect(() => journal.prepare("request-1", HASH, { ...request, queueNonce: "4" })).toThrow(/another request/i);
    journal.transition("request-1", "awaiting-primary");
    expect(() => journal.transition("request-1", "prepared")).toThrow(/transition/i);
    expect(() => journal.markUncertain("request-1")).toThrow(/submitting/i);
    journal.transition("request-1", "superseded");
    expect(() => journal.transition("request-1", "confirmed")).toThrow(/terminal/i);

    journal.prepare("request-2", OUTER, { kind: "transfer" });
    journal.markSubmitting("request-2", OUTER);
    journal.reconcile("request-2", { status: "reverted", transactionHash: OUTER });
    expect(journal.get("request-2")?.state).toBe("reverted");
    expect(() => journal.reconcile("request-2", { status: "confirmed", transactionHash: OUTER })).toThrow(/terminal/i);
  });
});
