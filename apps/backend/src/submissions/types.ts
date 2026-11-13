import type { Hex } from "viem";
import type { BackendPreparation } from "../vaults/types";
import type { JournalEntry, SubmissionJournal } from "./journal";

export type BackendSubmissionKind =
	| "base-transfer"
	| "step-up-transfer"
	| "queue-transfer"
	| "add-recipient"
	| "cancel-queued"
	| "execute-ready"
	| "skip-expired";

export type BackendPreparedSubmission = Readonly<{
	id: string;
	requestHash: Hex;
	safeTxHash?: Hex;
	kind: BackendSubmissionKind;
	requiredApprovals: readonly ("primary" | "secondary")[];
	publicRequest: Readonly<Record<string, unknown>>;
}>;

export type BackendSubmissionBody =
	Readonly<{ role: "primary" | "secondary"; assertion: unknown }> | Readonly<{ role: "none" }>;

export type BackendApproval = Readonly<{
	role: "primary" | "secondary";
	payload: Hex;
}>;

export type BackendSubmissionReceipt = Readonly<{
	status: "confirmed" | "reverted";
	transactionHash: Hex;
	blockNumber: bigint;
	blockHash: Hex;
}>;

export type BackendSubmissionView = Readonly<{
	publicRequest: Readonly<Record<string, unknown>>;
	createdAt?: number;
	id: string;
	state: JournalEntry["state"];
	kind: BackendSubmissionKind | string;
	requestHash: string;
	requiredApprovals: readonly ("primary" | "secondary")[];
	approvals: JournalEntry["approvals"];
	transactionHash?: string;
	receipt?: JournalEntry["receipt"];
}>;

export type PwaSubmissionServiceOptions = Readonly<{
	journal: SubmissionJournal;
	verifyApproval: (
		role: "primary" | "secondary",
		prepared: BackendPreparedSubmission,
		assertion: unknown,
	) => Promise<BackendApproval>;
	revalidate: (prepared: BackendPreparedSubmission) => Promise<void>;
	deriveOuterHash: (
		prepared: BackendPreparedSubmission,
		approvals: readonly BackendApproval[],
	) => Promise<Hex>;
	broadcast: (
		prepared: BackendPreparedSubmission,
		approvals: readonly BackendApproval[],
		outerTransactionHash: Hex,
	) => Promise<Hex>;
	reconcile: (outerTransactionHash: Hex) => Promise<BackendSubmissionReceipt | undefined>;
	discard?: (prepared: BackendPreparedSubmission) => void | Promise<void>;
}>;

export type ConfiguredSubmissionRuntime = Readonly<{
	prepare: BackendPreparation;
	revalidate: PwaSubmissionServiceOptions["revalidate"];
	deriveOuterHash: PwaSubmissionServiceOptions["deriveOuterHash"];
	broadcast: PwaSubmissionServiceOptions["broadcast"];
	reconcile: PwaSubmissionServiceOptions["reconcile"];
	discard?: PwaSubmissionServiceOptions["discard"];
}>;

/** Runtime-local public intent evidence; never contains approval payloads or relay secrets. */
export type SubmissionEntry = {
	vault: import("../vaults/types").BackendVaultRecord;
	intent: import("@tiered-spending-guard/security-core/pwa").PwaIntent;
	snapshot: import("@tiered-spending-guard/security-core/pwa").VerifiedPwaSnapshot;
	prepared: import("@tiered-spending-guard/security-core/pwa").PreparedPwaIntent;
	publicPrepared: BackendPreparedSubmission;
};

export type SubmissionReadClient = ReturnType<
	typeof import("./read-client").createSubmissionReadClient
>;
export type SubmissionRuntimeDependencies = Readonly<{
	providers: readonly [SubmissionReadClient, SubmissionReadClient];
	relay: SubmissionReadClient;
	beforeSign?(submissionId: string): void;
	sendRawTransaction(raw: Hex): Promise<Hex>;
}>;
