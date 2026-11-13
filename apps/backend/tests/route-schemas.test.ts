import { afterEach, describe, expect, it } from "vitest";
import { createBackendFastify } from "../src/http/fastify";
import { registerBackendDocumentation } from "../src/http/documentation";
import { registerAccountSubmissionRoutes } from "../src/submissions/routes";
import type { AccountRouteContext } from "../src/http/security";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
function fixture() {
	const seen: unknown[] = [];
	const fastify = createBackendFastify({});
	registerBackendDocumentation(fastify);
	fastify.register(async (routes) => {
		registerAccountSubmissionRoutes(
			routes,
			{
				prepare: async (_account, _session, input) => {
					seen.push(input);
					return { retained: true, amount: 5n };
				},
				submit: async () => {
					throw Error("unused");
				},
				status: async () => {
					throw Error("unused");
				},
			},
			{
				session: () => ({ id: "session" }),
				account: () => ({ id: "account" }),
			} as unknown as AccountRouteContext,
		);
	});
	cleanups.push(() => fastify.close());
	return {
		seen,
		post: (payload: unknown) =>
			fastify.inject({
				method: "POST",
				url: "/v1/submissions/prepare",
				payload: JSON.stringify(payload),
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:5173",
					"x-csrf-token": "csrf",
					"x-vault-account": "account",
				},
			}),
	};
}
const transfer = {
	kind: "transfer",
	recipient: `0x${"11".repeat(20)}`,
	amount: "1n",
	idempotencyKey: "test",
};
describe("submission request schemas", () => {
	it.each([
		{ ...transfer, arbitrary: "must be rejected" },
		{ ...transfer, amount: 1 },
		{ ...transfer, amount: true },
		{ ...transfer, recipient: 123 },
		{ ...transfer, idempotencyKey: ["test"] },
		{ kind: "transfer", recipient: transfer.recipient, idempotencyKey: "test" },
	])("rejects unknown, absent or wrongly typed fields without coercion: %j", async (body) => {
		const { seen, post } = fixture();
		expect((await post(body)).statusCode).toBe(400);
		expect(seen).toEqual([]);
	});
	it.each(["1n", "100000000000000000000000000000000000000000n", "1"])(
		"retains the accepted integer wire format %s",
		async (amount) => {
			const { seen, post } = fixture();
			const response = await post({ ...transfer, amount });
			expect(response.statusCode).toBe(200);
			expect(seen).toEqual([
				{
					...transfer,
					amount: amount.endsWith("n") ? BigInt(amount.slice(0, -1)) : amount,
				},
			]);
			expect(response.json()).toEqual({ retained: true, amount: "5n" });
		},
	);
});
