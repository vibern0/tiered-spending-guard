import {
	address,
	array,
	bigint,
	boolean,
	hash,
	id,
	inputUint,
	object,
	ref,
	role,
	string,
	type Schema,
} from "../http/schema";

const queueIntent = (kind: string): Schema =>
	object({
		kind: { type: "string", enum: [kind] },
		queueNonce: inputUint,
		queueFingerprint: hash,
		idempotencyKey: id,
	});

export const submissionsSchemas: Record<string, Schema> = {
	Prepare: {
		oneOf: [
			object({
				kind: { type: "string", enum: ["transfer"] },
				recipient: address,
				amount: inputUint,
				idempotencyKey: id,
			}),
			object({
				kind: { type: "string", enum: ["add-recipient"] },
				recipient: address,
				idempotencyKey: id,
			}),
			queueIntent("cancel-queued"),
			queueIntent("execute-ready"),
			queueIntent("skip-expired"),
		],
		description:
			"Closed intents only. Backend derives policy, nonce, providers, fees and calldata. Transfers classify into base, step-up or delayed. Queue actions bind the exact queue nonce and fingerprint.",
	},
	Prepared: object(
		{
			id,
			requestHash: hash,
			safeTxHash: hash,
			kind: {
				type: "string",
				enum: [
					"base-transfer",
					"step-up-transfer",
					"queue-transfer",
					"add-recipient",
					"cancel-queued",
					"execute-ready",
					"skip-expired",
				],
			},
			requiredApprovals: array(role),
			publicRequest: {
				type: "object",
				additionalProperties: true,
				description:
					"Public immutable prepared intent including idempotency key, verified snapshot/policy bindings, transaction and queue details. Bigints use decimal strings suffixed n. Never contains private signing material.",
			},
		},
		["id", "requestHash", "kind", "requiredApprovals", "publicRequest"],
	),
	Submit: {
		oneOf: [
			object({ role, assertion: ref("Assertion") }),
			object({ role: { type: "string", enum: ["none"] } }),
		],
		description:
			"Primary assertion first; secondary only when required. Assertions approve the exact prepared Safe digest. role=none only executes an already-ready queue head or skips an expired head; it grants no new approval.",
	},
	Submission: object(
		{
			id,
			state: {
				type: "string",
				enum: [
					"prepared",
					"awaiting-primary",
					"awaiting-secondary",
					"submitting",
					"uncertain",
					"confirmed",
					"reverted",
					"superseded",
				],
			},
			kind: string,
			requestHash: hash,
			requiredApprovals: array(role),
			approvals: object({ primary: boolean, secondary: boolean }),
			transactionHash: hash,
			receipt: object({ transactionHash: hash, blockNumber: bigint, blockHash: hash }),
		},
		["id", "state", "kind", "requestHash", "requiredApprovals", "approvals"],
	),
};
