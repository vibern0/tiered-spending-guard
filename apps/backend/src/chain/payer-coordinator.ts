import * as namespace from "@tiered-spending-guard/security-core/pwa";
import { existsSync, readdirSync } from "node:fs";
import type { Address } from "viem";
import type { AccountStore } from "../accounts/store";
import { SubmissionJournal } from "../submissions/journal";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;

/** One queue and filesystem lease for the shared payer across every account. */
export function createPayerCoordinator(store: AccountStore, payer: Address) {
	let queue: Promise<unknown> = Promise.resolve();
	const assertPayerAvailable = (
		requesting: string,
		kind: "provision" | "submit",
		submissionId?: string,
	) => {
		// Stream accounts, not a capped array or an eagerly loaded runtime per user.
		// Source journals are re-read: a stale database/index cannot hide a hash.
		store.validateEvidenceInventory();
		for (const a of store.accounts()) {
			const journal = core.readLiveJournal(a.config.provisioningJournalPath, payer);
			const hasReviews =
				existsSync(a.config.provisioningReviewDirectory) &&
				readdirSync(a.config.provisioningReviewDirectory).some((name) =>
					name.endsWith(".json"),
				);
			if (
				journal.entries.some((row) => row.status !== "success") &&
				!(a.id === requesting && kind === "provision")
			)
				throw new Error("another account has an unresolved provisioning transaction");
			if (a.state === "verified" && journal.entries.length !== 7)
				throw new Error("completed account provisioning evidence is missing");
			if (
				a.id !== requesting &&
				(a.state === "provisioning" ||
					(journal.entries.length > 0 && journal.entries.length < 7) ||
					(hasReviews && journal.entries.length < 7))
			)
				throw new Error("another account has an incomplete immutable deployment");
			if (a.id === requesting && kind === "submit" && a.state !== "verified")
				throw new Error("account deployment is not verified");
			if (a.state === "verified" && !a.legacy && !existsSync(a.config.journalPath))
				throw new Error("completed account submission evidence is missing");
			if (existsSync(a.config.journalPath)) {
				const pending = new SubmissionJournal(a.config.journalPath).listPending();
				for (const entry of pending)
					if (!(a.id === requesting && kind === "submit" && entry.id === submissionId))
						throw new Error("an account has an unresolved durable submission hash");
			}
		}
	};
	const withPayer = <T>(
		id: string,
		kind: "provision" | "submit",
		operation: () => Promise<T>,
		submissionId?: string,
	): Promise<T> => {
		const pending = queue.then(async () => {
			const lease = core.acquireLocalWriterLease(`${store.databasePath}.payer.lock`);
			try {
				assertPayerAvailable(id, kind, submissionId);
				return await operation();
			} finally {
				lease.close();
			}
		});
		queue = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	};
	return { withPayer };
}
