import { keccak256, type Address, type Hex } from "viem";
import { SubmissionJournal, type JournalEntry } from "./journal";
import type {
	BackendApproval,
	BackendPreparedSubmission,
	BackendSubmissionBody,
	BackendSubmissionReceipt,
	BackendSubmissionView,
	PwaSubmissionServiceOptions,
} from "./types";

export const SEPOLIA_USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;

const bytes32 = /^0x[0-9a-fA-F]{64}$/;

/** Reject unsupported prepared kinds, approval ordering or missing exact transaction bindings. */
function assertPreparedSubmission(value: BackendPreparedSubmission): void {
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value.id) || !bytes32.test(value.requestHash)) {
		throw new Error("prepared submission identity is invalid");
	}
	if (
		![
			"base-transfer",
			"step-up-transfer",
			"queue-transfer",
			"add-recipient",
			"cancel-queued",
			"execute-ready",
			"skip-expired",
		].includes(value.kind)
	) {
		throw new Error("prepared submission kind is invalid");
	}
	const direct = value.kind === "execute-ready" || value.kind === "skip-expired";
	const expected =
		value.kind === "base-transfer" ? ["primary"] : direct ? [] : ["primary", "secondary"];
	if (
		value.requiredApprovals.length !== expected.length ||
		value.requiredApprovals.some((role, index) => role !== expected[index])
	) {
		throw new Error("prepared submission approval roles are invalid");
	}
	if (!direct && (!value.safeTxHash || !bytes32.test(value.safeTxHash))) {
		throw new Error("signed submission requires an exact Safe transaction hash");
	}
}

/** Accept only an exact role/assertion pair or an otherwise empty permissionless request. */
function assertSubmitBody(body: BackendSubmissionBody): void {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("submission body must be an object");
	}
	const keys = Object.keys(body);
	if (body.role === "none") {
		if (keys.length !== 1) {
			throw new Error("permissionless submission contains an unsupported field");
		}
		return;
	}
	if (
		(body.role !== "primary" && body.role !== "secondary") ||
		keys.length !== 2 ||
		!keys.includes("assertion")
	) {
		throw new Error("signed submission body is invalid");
	}
}

/** Project retained public evidence and approval presence without exposing signing payloads. */
function publicView(
	entry: JournalEntry,
	prepared?: BackendPreparedSubmission,
): BackendSubmissionView {
	return Object.freeze({
		id: entry.id,
		publicRequest: entry.publicRequest,
		...(typeof entry.publicRequest.preparedAt === "number"
			? { createdAt: entry.publicRequest.preparedAt }
			: {}),
		state: entry.state,
		kind:
			prepared?.kind ??
			String(entry.publicRequest.preparedKind ?? entry.publicRequest.kind ?? "unknown"),
		requestHash: entry.requestHash,
		requiredApprovals: prepared?.requiredApprovals ?? [],
		approvals: entry.approvals,
		...(entry.outerTransactionHash ? { transactionHash: entry.outerTransactionHash } : {}),
		...(entry.receipt ? { receipt: entry.receipt } : {}),
	});
}

/** Durable public state plus process-local, one-use WebAuthn approvals. */
export class PwaSubmissionService {
	readonly journal: SubmissionJournal;
	readonly broadcast: PwaSubmissionServiceOptions["broadcast"];
	private readonly options: PwaSubmissionServiceOptions;
	private readonly prepared = new Map<string, BackendPreparedSubmission>();
	private readonly approvals = new Map<string, Map<"primary" | "secondary", BackendApproval>>();
	private readonly flights = new Map<string, Promise<BackendSubmissionView>>();
	private readonly statusFlights = new Map<string, Promise<BackendSubmissionView>>();

	/** Connect the durable journal to approval verification, bounded execution and receipt observation. */
	constructor(options: PwaSubmissionServiceOptions) {
		this.options = options;
		this.journal = options.journal;
		this.broadcast = options.broadcast;
	}

	/**
	 * Bind an immutable prepared intent to its durable ID and start its approval state.
	 * Retains the full prepared intent only in this process; the journal stores public evidence.
	 */
	prepare(prepared: BackendPreparedSubmission): BackendPreparedSubmission {
		assertPreparedSubmission(prepared);
		const existing = this.prepared.get(prepared.id);
		if (existing && existing.requestHash.toLowerCase() !== prepared.requestHash.toLowerCase()) {
			throw new Error("submission ID is already bound to another request");
		}
		const entry = this.journal.prepare(
			prepared.id,
			prepared.requestHash,
			prepared.publicRequest,
		);
		this.prepared.set(
			prepared.id,
			existing ??
				Object.freeze({
					...prepared,
					requiredApprovals: Object.freeze([...prepared.requiredApprovals]),
					publicRequest: entry.publicRequest,
				}),
		);
		if (entry.state === "prepared" && prepared.requiredApprovals.length > 0) {
			this.journal.transition(prepared.id, "awaiting-primary");
		}
		return this.prepared.get(prepared.id)!;
	}

	/**
	 * Erase process-local approval payloads for matching submissions without changing durable evidence.
	 * @param matches Selects submission IDs whose one-use approvals must be invalidated.
	 */
	forgetApprovalsFor(matches: (id: string) => boolean): void {
		for (const id of this.approvals.keys()) {
			if (matches(id)) {
				this.approvals.delete(id);
			}
		}
	}

	/** Coalesce concurrent submission attempts for an ID into one approval or execution operation. */
	submit(id: string, body: BackendSubmissionBody): Promise<BackendSubmissionView> {
		const active = this.flights.get(id);
		if (active) {
			return active;
		}
		const flight = this.submitOnce(id, body).finally(() => this.flights.delete(id));
		this.flights.set(id, flight);
		return flight;
	}

	/** Coalesce read-only status polls; unresolved durable hashes may acquire terminal receipt evidence. */
	status(id: string): Promise<BackendSubmissionView> {
		const active = this.statusFlights.get(id);
		if (active) {
			return active;
		}
		const flight = this.statusOnce(id).finally(() => this.statusFlights.delete(id));
		this.statusFlights.set(id, flight);
		return flight;
	}

	/** Reconcile only the retained outer hash for unresolved submissions, without signing or broadcasting. */
	private async statusOnce(id: string): Promise<BackendSubmissionView> {
		const entry = this.journal.get(id);
		if (!entry) {
			throw new Error("unknown submission");
		}
		if (entry.state === "submitting" || entry.state === "uncertain") {
			if (!entry.outerTransactionHash || !bytes32.test(entry.outerTransactionHash)) {
				throw new Error("durable outer transaction hash is missing");
			}
			const receipt = await this.options.reconcile(entry.outerTransactionHash as Hex);
			if (receipt) {
				if (
					receipt.transactionHash.toLowerCase() !==
					entry.outerTransactionHash.toLowerCase()
				) {
					throw new Error("reconciliation returned another transaction hash");
				}
				return this.reconcileTerminalView(id, receipt);
			}
		}
		return publicView(entry, this.prepared.get(id));
	}

	/**
	 * Verify fresh ordered approvals for the exact prepared intent, then execute when all roles are present.
	 * Permissionless lifecycle calls accept no approvals; already-submitted IDs only reconcile status.
	 */
	private async submitOnce(
		id: string,
		body: BackendSubmissionBody,
	): Promise<BackendSubmissionView> {
		assertSubmitBody(body);
		const prepared = this.prepared.get(id);
		if (!prepared) {
			return this.status(id);
		}
		const existing = this.journal.get(id);
		if (!existing) {
			throw new Error("unknown submission");
		}
		if (
			["submitting", "uncertain", "confirmed", "reverted", "superseded"].includes(
				existing.state,
			)
		) {
			return this.status(id);
		}
		const direct = prepared.requiredApprovals.length === 0;
		if (body.role === "none") {
			if (!direct) {
				throw new Error(
					"permissionless submission is allowed only for ready execution or expired skip",
				);
			}
			return this.broadcastPrepared(prepared, []);
		}
		if (direct) {
			throw new Error("permissionless lifecycle submission must use role none");
		}
		if (!prepared.requiredApprovals.includes(body.role)) {
			throw new Error(`${body.role} approval is not required`);
		}
		const current =
			this.approvals.get(id) ?? new Map<"primary" | "secondary", BackendApproval>();
		if (body.role === "secondary" && !current.has("primary")) {
			throw new Error("primary approval is required before secondary approval");
		}
		if (current.has(body.role)) {
			throw new Error(`${body.role} approval is already present`);
		}
		await this.revalidateOrSupersede(prepared);
		const approval = await this.options.verifyApproval(body.role, prepared, body.assertion);
		if (approval.role !== body.role || !/^0x(?:[0-9a-fA-F]{2})+$/.test(approval.payload)) {
			throw new Error("verified approval does not match the requested role");
		}
		current.set(body.role, approval);
		this.approvals.set(id, current);
		this.journal.recordApproval(id, body.role, keccak256(approval.payload));
		if (prepared.requiredApprovals.some((role) => !current.has(role))) {
			return publicView(this.journal.get(id)!, prepared);
		}
		return this.broadcastPrepared(
			prepared,
			prepared.requiredApprovals.map((role) => current.get(role)!),
		);
	}

	/**
	 * Revalidate, derive and durably record the exact outer hash before broadcasting once.
	 * Erase approval payloads after the attempt and retain uncertainty when broadcast outcome is unknown.
	 */
	private async broadcastPrepared(
		prepared: BackendPreparedSubmission,
		approvals: readonly BackendApproval[],
	): Promise<BackendSubmissionView> {
		await this.revalidateOrSupersede(prepared);
		let outerTransactionHash: Hex;
		try {
			outerTransactionHash = await this.options.deriveOuterHash(prepared, approvals);
			if (!bytes32.test(outerTransactionHash)) {
				throw new Error("locally derived outer transaction hash is invalid");
			}
		} catch (error) {
			await this.discardBeforeBroadcast(prepared);
			throw error;
		}
		try {
			this.journal.markSubmitting(prepared.id, outerTransactionHash);
		} catch (error) {
			await this.discardBeforeBroadcast(prepared);
			throw error;
		}
		try {
			const broadcastHash = await this.options.broadcast(
				prepared,
				approvals,
				outerTransactionHash,
			);
			if (broadcastHash.toLowerCase() !== outerTransactionHash.toLowerCase()) {
				throw new Error("provider returned another transaction hash");
			}
			const view = await this.status(prepared.id);
			if (view.state === "submitting") {
				this.journal.markUncertain(prepared.id);
			}
			return publicView(this.journal.get(prepared.id)!, prepared);
		} catch {
			// A read-only poll may have completed the receipt while broadcast was in
			// flight. Never downgrade that durable evidence after a provider failure.
			if (this.journal.get(prepared.id)?.state === "submitting") {
				this.journal.markUncertain(prepared.id);
			}
			throw new Error("submission became uncertain; reconcile the durable outer hash");
		} finally {
			this.approvals.delete(prepared.id);
		}
	}

	/** Persist terminal receipt evidence while accepting only identical evidence from concurrent reconciliation. */
	private reconcileTerminalView(
		id: string,
		receipt: BackendSubmissionReceipt,
	): BackendSubmissionView {
		/** Reuse an existing terminal view only when its status and complete receipt identity match. */
		const retained = (): BackendSubmissionView | undefined => {
			const current = this.journal.get(id);
			if (!current || (current.state !== "confirmed" && current.state !== "reverted")) {
				return undefined;
			}
			if (
				current.state !== receipt.status ||
				current.outerTransactionHash?.toLowerCase() !==
					receipt.transactionHash.toLowerCase() ||
				current.receipt?.transactionHash.toLowerCase() !==
					receipt.transactionHash.toLowerCase() ||
				current.receipt?.blockNumber !== receipt.blockNumber ||
				current.receipt?.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
			) {
				throw new Error("terminal receipt conflicts with retained evidence");
			}
			return publicView(current, this.prepared.get(id));
		};
		const existing = retained();
		if (existing) {
			return existing;
		}
		try {
			return publicView(this.journal.reconcile(id, receipt), this.prepared.get(id));
		} catch (error) {
			// Another process can finish between the fresh read and the locked mutation.
			// Only a terminal-state race is reusable; persistence errors must still stop.
			if (
				error instanceof Error &&
				/^terminal submission cannot be reconciled from (confirmed|reverted)$/.test(
					error.message,
				)
			) {
				const raced = retained();
				if (raced) {
					return raced;
				}
			}
			throw error;
		}
	}

	/** Invalidate the submission and its approvals when current chain state no longer permits its intent. */
	private async revalidateOrSupersede(prepared: BackendPreparedSubmission): Promise<void> {
		try {
			await this.options.revalidate(prepared);
		} catch (error) {
			this.supersede(prepared.id);
			throw error;
		}
	}

	/**
	 * Release execution resources and invalidate approvals after a pre-broadcast failure.
	 * Cleanup failures must preserve the original error and never trigger a broadcast.
	 */
	private async discardBeforeBroadcast(prepared: BackendPreparedSubmission): Promise<void> {
		this.approvals.delete(prepared.id);
		try {
			await this.options.discard?.(prepared);
		} catch {
			/* Preserve the signing/persistence failure; never broadcast. */
		}
		try {
			this.supersede(prepared.id);
		} catch {
			/* A failed journal remains non-authorizing. */
		}
	}

	/** Drop volatile approvals and durably supersede a submission unless it already has terminal evidence. */
	private supersede(id: string): void {
		this.approvals.delete(id);
		const entry = this.journal.get(id);
		if (entry && !["confirmed", "reverted", "superseded"].includes(entry.state)) {
			this.journal.transition(id, "superseded");
		}
	}
}
