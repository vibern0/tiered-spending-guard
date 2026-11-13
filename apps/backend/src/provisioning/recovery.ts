import * as namespace from "@tiered-spending-guard/security-core/pwa";
import type { Address } from "viem";
import type {
	PwaProvisioningRecovery,
	ResolvePwaProvisioningRecoveryInput,
	HistoricalPwaReadClient,
	PwaProvisioningRecoveryClient,
} from "@tiered-spending-guard/security-core/pwa";
import type { BackendConfig } from "../config/config";

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
	pending?: true;
}>;

/** Read/reconcile exact recorded evidence; never signs or broadcasts. */
export async function recoverAutomaticPwaProvisioning(input: Input): Promise<AutomaticRecovery> {
	const store = core.createLiveJournalStore(input.config.provisioningJournalPath, input.deployer);
	const restore = async (): Promise<AutomaticRecovery> => {
		let journal = store.load();
		if (!journal.entries.length) return {};
		const facts = () => ({
			reviewDirectory: input.config.provisioningReviewDirectory,
			journal,
			profile: input.profile,
			safeProxySaltNonce: input.safeProxySaltNonce,
			providers: input.providers,
			relay: input.relay,
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
		return { recovery: await core.resolvePwaProvisioningRecovery(facts()) };
	};
	try {
		return await restore();
	} finally {
		store.close();
	}
}
