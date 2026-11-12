import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionJournal } from "../src/submissions/journal";

const syncEvidence = vi.hoisted(() => ({ events: [] as string[], failFileSync: false }));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		fsyncSync: (fd: number) => {
			const stat = actual.fstatSync(fd);
			// The shared writer lease may also sync its short PID-only lock file.
			if (!stat.isDirectory() && stat.size <= 32) return actual.fsyncSync(fd);
			const kind = stat.isDirectory() ? "directory" : "file";
			syncEvidence.events.push(`sync:${kind}`);
			if (kind === "file" && syncEvidence.failFileSync) throw new Error("file sync failed");
			return actual.fsyncSync(fd);
		},
		renameSync: (...args: Parameters<typeof actual.renameSync>) => {
			syncEvidence.events.push("rename");
			return actual.renameSync(...args);
		},
	};
});

const directories: string[] = [];
const HASH = `0x${"aa".repeat(32)}`;
const OUTER = `0x${"bb".repeat(32)}`;
const BLOCK = `0x${"cc".repeat(32)}`;

afterEach(() => {
	syncEvidence.failFileSync = false;
	syncEvidence.events.length = 0;
	directories
		.splice(0)
		.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("submission journal", () => {
	it("syncs the signed-hash file before rename and syncs its directory before returning", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-journal-sync-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const journal = new SubmissionJournal(path);
		journal.prepare("request-1", HASH);
		syncEvidence.events.length = 0;
		journal.markSubmitting("request-1", OUTER);
		expect(syncEvidence.events).toEqual(["sync:file", "rename", "sync:directory"]);
		expect(new SubmissionJournal(path).get("request-1")?.outerTransactionHash).toBe(OUTER);
	});

	it("does not advance a signed-hash row or retain its mutation lock when file sync fails", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-journal-sync-failure-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const journal = new SubmissionJournal(path);
		journal.prepare("request-1", HASH);
		const before = readFileSync(path, "utf8");
		syncEvidence.failFileSync = true;
		expect(() => journal.markSubmitting("request-1", OUTER)).toThrow(/sync failed/);
		syncEvidence.failFileSync = false;
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(journal.get("request-1")).toMatchObject({ state: "prepared" });
		expect(journal.get("request-1")).not.toHaveProperty("outerTransactionHash");
		expect(journal.markSubmitting("request-1", OUTER).outerTransactionHash).toBe(OUTER);
	});

	it("reloads under each mutation lock so separate instances preserve rows and terminal state", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-journal-shared-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const first = new SubmissionJournal(path);
		const second = new SubmissionJournal(path);
		first.prepare("request-1", HASH);
		second.prepare("request-2", BLOCK);
		expect(new SubmissionJournal(path).get("request-1")).toMatchObject({ requestHash: HASH });
		expect(first.get("request-2")).toMatchObject({ requestHash: BLOCK });
		first.markSubmitting("request-1", OUTER);
		second.reconcile("request-1", {
			status: "confirmed",
			transactionHash: OUTER,
			blockNumber: 12n,
			blockHash: BLOCK,
		});
		expect(() => first.markUncertain("request-1")).toThrow(/submitting|terminal/);
		expect(first.get("request-1")?.state).toBe("confirmed");
	});

	it("lists immutable current pending rows across restart and subsequent external reconciliation", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-journal-pending-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const journal = new SubmissionJournal(path);
		journal.prepare("prepared", HASH);
		journal.prepare("pending", BLOCK);
		journal.markSubmitting("pending", OUTER);
		const restarted = new SubmissionJournal(path);
		const rows = restarted.listPending();
		expect(rows.map((entry) => entry.id)).toEqual(["pending"]);
		expect(Object.isFrozen(rows)).toBe(true);
		expect(Object.isFrozen(rows[0])).toBe(true);
		journal.markUncertain("pending");
		expect(restarted.listPending()[0]?.state).toBe("uncertain");
		journal.reconcile("pending", {
			status: "reverted",
			transactionHash: OUTER,
			blockNumber: 12n,
			blockHash: BLOCK,
		});
		expect(restarted.listPending()).toEqual([]);
	});

	it("fails closed on a contended writer lock without removing it or changing the journal", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-journal-lock-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const journal = new SubmissionJournal(path);
		journal.prepare("request-1", HASH);
		const before = readFileSync(path, "utf8");
		writeFileSync(`${path}.lock`, "another writer", { flag: "wx" });
		expect(() => journal.prepare("request-2", OUTER)).toThrow(/lock/i);
		expect(readFileSync(`${path}.lock`, "utf8")).toBe("another writer");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("finds a unique durable outer hash after restart and rejects ambiguous or malformed lookups", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-submission-hash-lookup-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const journal = new SubmissionJournal(path);
		journal.prepare("request-1", HASH, {
			kind: "transfer",
			preparedBlockNumber: "12",
			intent: { kind: "transfer", amount: "1" },
		});
		journal.markSubmitting("request-1", OUTER);
		const restarted = new SubmissionJournal(path);
		expect(restarted.findByOuterHash(`0x${OUTER.slice(2).toUpperCase()}`)).toMatchObject({
			id: "request-1",
			state: "submitting",
			publicRequest: { preparedBlockNumber: "12" },
		});
		expect(restarted.findByOuterHash(HASH)).toBeUndefined();
		expect(() => restarted.findByOuterHash("not-a-hash")).toThrow(/invalid/i);
		restarted.prepare("request-2", BLOCK, { kind: "transfer" });
		restarted.markSubmitting("request-2", OUTER);
		expect(() => restarted.findByOuterHash(OUTER)).toThrow(/ambiguous/i);
	});
	it("persists the monotonic lifecycle and public receipt without signatures", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-submission-journal-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const journal = new SubmissionJournal(path);
		const request = {
			kind: "transfer",
			recipient: "0x1111111111111111111111111111111111111111",
			amount: "1000000",
		};

		expect(journal.prepare("request-1", HASH, request).state).toBe("prepared");
		expect(journal.transition("request-1", "awaiting-primary").state).toBe("awaiting-primary");
		expect(journal.recordApproval("request-1", "primary", HASH).state).toBe(
			"awaiting-secondary",
		);
		expect(journal.recordApproval("request-1", "secondary", OUTER).approvals).toEqual({
			primary: true,
			secondary: true,
		});
		expect(journal.markSubmitting("request-1", OUTER).state).toBe("submitting");
		expect(journal.markUncertain("request-1").state).toBe("uncertain");
		expect(
			journal.reconcile("request-1", {
				status: "confirmed",
				transactionHash: OUTER,
				blockNumber: 12n,
				blockHash: BLOCK,
			}).state,
		).toBe("confirmed");

		const restarted = new SubmissionJournal(path);
		expect(restarted.get("request-1")).toMatchObject({
			state: "confirmed",
			requestHash: HASH,
			outerTransactionHash: OUTER,
			receipt: { blockNumber: 12n, blockHash: BLOCK },
		});
		const persisted = readFileSync(path, "utf8");
		expect(persisted).not.toMatch(/assertion|signature|credential|private|secret/i);
	});

	it("deduplicates exact public requests and rejects byte or state rollback", () => {
		const journal = new SubmissionJournal();
		const request = {
			kind: "execute-ready",
			queueNonce: "3",
			queueFingerprint: HASH,
			queue: { to: "0x1111111111111111111111111111111111111111" },
		};
		const prepared = journal.prepare("request-1", HASH, request);
		expect(prepared).toBe(journal.prepare("request-1", HASH, request));
		expect(() => {
			(prepared.publicRequest.queue as { to: string }).to = "changed";
		}).toThrow();
		expect(() => journal.prepare("request-1", OUTER, request)).toThrow(/another request/i);
		expect(() => journal.prepare("request-1", HASH, { ...request, queueNonce: "4" })).toThrow(
			/another request/i,
		);
		journal.transition("request-1", "awaiting-primary");
		expect(() => journal.transition("request-1", "prepared")).toThrow(/transition/i);
		expect(() => journal.markUncertain("request-1")).toThrow(/submitting/i);
		journal.transition("request-1", "superseded");
		expect(() => journal.transition("request-1", "confirmed")).toThrow(/terminal/i);

		journal.prepare("request-2", OUTER, { kind: "transfer" });
		journal.markSubmitting("request-2", OUTER);
		journal.reconcile("request-2", {
			status: "reverted",
			transactionHash: OUTER,
		});
		expect(journal.get("request-2")?.state).toBe("reverted");
		expect(() =>
			journal.reconcile("request-2", {
				status: "confirmed",
				transactionHash: OUTER,
			}),
		).toThrow(/terminal/i);
	});

	it("fails closed on incomplete receipts and malformed durable state", () => {
		const journal = new SubmissionJournal();
		journal.prepare("request-1", HASH, { kind: "transfer" });
		journal.markSubmitting("request-1", OUTER);
		expect(() =>
			journal.reconcile("request-1", {
				status: "confirmed",
				transactionHash: OUTER,
				blockNumber: 12n,
			}),
		).toThrow(/incomplete/i);
		expect(() =>
			journal.reconcile("request-1", {
				status: "confirmed",
				transactionHash: OUTER,
				blockNumber: -1n,
				blockHash: BLOCK,
			}),
		).toThrow(/block number/i);

		const directory = mkdtempSync(join(tmpdir(), "pwa-submission-journal-malformed-"));
		directories.push(directory);
		const path = join(directory, "journal.json");
		const malformed = [
			{
				id: "request-1",
				requestHash: HASH,
				publicRequest: {},
				state: "confirmed",
				approvals: { primary: true, secondary: false },
				outerTransactionHash: OUTER,
				receipt: { transactionHash: HASH, blockNumber: "12", blockHash: BLOCK },
			},
		];
		writeFileSync(path, JSON.stringify(malformed), { mode: 0o600 });
		expect(() => new SubmissionJournal(path)).toThrow(/loaded safely/i);

		writeFileSync(
			path,
			JSON.stringify([
				{
					id: "request-1",
					requestHash: HASH,
					publicRequest: {},
					state: "prepared",
					approvals: { primary: false, secondary: false },
					signature: "0xsecret",
				},
			]),
			{ mode: 0o600 },
		);
		expect(() => new SubmissionJournal(path)).toThrow(/loaded safely/i);

		writeFileSync(
			path,
			JSON.stringify([
				{
					id: "request-1",
					requestHash: HASH,
					publicRequest: {},
					state: "toString",
					approvals: { primary: false, secondary: false },
				},
			]),
			{ mode: 0o600 },
		);
		expect(() => new SubmissionJournal(path)).toThrow(/loaded safely/i);
	});
});
