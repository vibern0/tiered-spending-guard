import * as namespace from "@tiered-spending-guard/security-core/pwa";
import type { Address } from "viem";
import type {
	PwaHistoricalVault,
	PwaProvisioningRecovery,
	ResolvePwaProvisioningRecoveryInput,
	PwaProvisioningSuccessor,
	HistoricalPwaReadClient,
	PwaProvisioningRecoveryClient,
} from "@tiered-spending-guard/security-core/pwa";
import type { BackendConfig } from "../config/config";
import {
	appendManagedPwaSuccessor,
	loadManagedPwaSuccessors,
	mergePwaSuccessors,
} from "./successors";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
type Input = Pick<ResolvePwaProvisioningRecoveryInput, "profile" | "safeProxySaltNonce" | "relay"> &
	Readonly<{
		config: BackendConfig;
		deployer: Address;
		providers: readonly [
			PwaProvisioningRecoveryClient & HistoricalPwaReadClient,
			PwaProvisioningRecoveryClient & HistoricalPwaReadClient,
		];
		waitForPending?: boolean;
	}>;
export type AutomaticRecovery = Readonly<{
	recovery?: PwaProvisioningRecovery;
	historicalVault?: PwaHistoricalVault;
	pending?: true;
}>;

/** Read/reconcile exact recorded evidence; never signs or broadcasts. */
export async function recoverAutomaticPwaProvisioning(input: Input): Promise<AutomaticRecovery> {
	const store = core.createLiveJournalStore(input.config.provisioningJournalPath, input.deployer);
	const restore = async (): Promise<AutomaticRecovery> => {
		let journal = store.load();
		if (!journal.entries.length) return {};
		const committed = core.loadCommittedPwaProvisioningSuccessors();
		const managed = loadManagedPwaSuccessors(
			input.config.provisioningJournalPath,
			input.deployer,
		);
		const successors: readonly PwaProvisioningSuccessor[] = mergePwaSuccessors(
			committed,
			managed,
		);
		const facts = () => ({
			reviewDirectory: input.config.provisioningReviewDirectory,
			journal,
			profile: input.profile,
			safeProxySaltNonce: input.safeProxySaltNonce,
			providers: input.providers,
			relay: input.relay,
			successors,
		});
		for (
			let attempt = 0;
			journal.entries.some((entry) => entry.status === "pending");
			attempt++
		) {
			const reconciled = await core.reconcilePwaProvisioningPending(facts());
			if (!reconciled.entries.some((entry) => entry.status === "pending")) {
				store.save(reconciled);
				journal = reconciled;
				break;
			}
			if (!input.waitForPending || attempt >= 24) return { pending: true };
			await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
		}
		const historicalVault = await core.resolveCompletedHistoricalPwaVault({
			reviewDirectory: input.config.provisioningReviewDirectory,
			journal,
			providers: input.providers,
			relay: input.relay,
			successors,
		});
		if (historicalVault) return { historicalVault };
		try {
			return { recovery: await core.resolvePwaProvisioningRecovery(facts()) };
		} catch (original) {
			if (
				(original instanceof Error &&
					/Sepolia RPC request failed/.test(original.message)) ||
				(journal.entries.length !== 1 && journal.entries.length !== 2)
			)
				throw original;
			const candidate = await core.discoverPwaProvisioningSuccessor(facts());
			if (!candidate) throw original;
			const selected = [
				...successors.filter(
					(value) => value.originalPackageHash !== candidate.originalPackageHash,
				),
				candidate,
			];
			const recovery = await core.resolvePwaProvisioningRecovery({
				...facts(),
				successors: selected,
			});
			if (!recovery) throw new Error("automatic recovery did not produce a verified plan");
			// Exact verified lineage and new unsigned package are retained before any
			// authorization/signature can use the new, unexecuted deployment suffix.
			appendManagedPwaSuccessor(
				input.config.provisioningJournalPath,
				input.deployer,
				candidate,
			);
			core.writePwaProvisioningReview(
				recovery.plan,
				input.config.provisioningReviewDirectory,
			);
			return { recovery };
		}
	};
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				return await restore();
			} catch (error) {
				// These exact proof failures mean canonical evidence needs more blocks.
				// All other disagreements/malformed evidence still fail closed immediately.
				const awaitingConfirmations =
					error instanceof Error &&
					[
						"automatic successor nonce history is not fully confirmed within its anchors",
						"a successor consumed transaction has fewer than six confirmations",
						"automatic successor cannot proceed with pending or unknown nonce consumption",
					].some(
						(reason) =>
							error.message === `fail closed: PWA provisioning recovery ${reason}`,
					);
				if (!awaitingConfirmations) throw error;
				if (!input.waitForPending || attempt >= 24) return { pending: true };
				await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
			}
		}
	} finally {
		store.close();
	}
}
