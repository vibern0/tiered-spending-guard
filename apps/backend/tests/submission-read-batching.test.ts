import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAbi, type Address } from "viem";
import { createSubmissionReadClient } from "../src/submissions/runtime";

const address = `0x${"11".repeat(20)}` as Address;
const zeroWord = `0x${"00".repeat(32)}`;
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((e) => (e ? reject(e) : resolve())),
					),
			),
	);
});
async function rpc(failStorage = false, mutate?: (responses: any[]) => unknown) {
	const batches: unknown[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const parsed = JSON.parse(body);
		batches.push(parsed);
		const answer = (request: { id: number; method: string }) => ({
			jsonrpc: "2.0",
			id: request.id,
			...(failStorage && request.method === "eth_getStorageAt"
				? { error: { code: -32602, message: "bad member" } }
				: { result: request.method === "eth_getCode" ? "0x6000" : zeroWord }),
		});
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify(
				Array.isArray(parsed)
					? (mutate?.(parsed.map(answer).reverse()) ?? parsed.map(answer).reverse())
					: answer(parsed),
			),
		);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return { batches, url, client: createSubmissionReadClient(url, "batch-test") };
}
describe("submission JSON-RPC batching", () => {
	it("splits concurrent reads into batches of at most four without omitting checks", async () => {
		const { client, batches } = await rpc();
		const results = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				client.getBytecode({ address, blockNumber: BigInt(index + 1) }),
			),
		);
		expect(results).toEqual(Array(24).fill("0x6000"));
		expect(batches.map((batch) => (batch as unknown[]).length).sort((a, b) => a - b)).toEqual([
			4, 4, 4, 4, 4, 4,
		]);
		expect(
			(batches as { params: unknown[] }[][])
				.flat()
				.map((call) => call.params.at(-1))
				.sort(),
		).toEqual(Array.from({ length: 24 }, (_, index) => `0x${(index + 1).toString(16)}`).sort());
	});
	it("rejects redirects instead of accepting evidence from another operator", async () => {
		const target = await rpc();
		const redirect = createServer((_request, response) => {
			// False positive: this intentional redirect targets a test-owned loopback
			// server, never request data. The client must reject it without following.
			// Rule names cover the legacy and current GitLab rule identifiers.
			// nosemgrep: rules_lgpl_javascript_redirect_rule-express-open-redirect2, javascript-redirect-rule-express_open_redirect2
			response.writeHead(307, { location: target.url });
			response.end();
		});
		servers.push(redirect);
		await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
		const client = createSubmissionReadClient(
			`http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
			"redirect-test",
		);
		await expect(client.getBytecode({ address, blockNumber: 10n })).rejects.toThrow(
			"Sepolia RPC request failed",
		);
		expect(target.batches).toHaveLength(0);
	});
	it("groups concurrent pinned reads while matching reversed responses by id", async () => {
		const { batches, client } = await rpc();
		const result = await Promise.all([
			client.getBytecode({ address, blockNumber: 10n }),
			client.getStorageAt({ address, slot: zeroWord as `0x${string}`, blockNumber: 10n }),
			client.readContract({
				address,
				abi: parseAbi(["function nonce() view returns (uint256)"]),
				functionName: "nonce",
				blockNumber: 10n,
			}),
		]);
		expect(result).toEqual(["0x6000", zeroWord, 0n]);
		expect(batches).toHaveLength(1);
		expect(Array.isArray(batches[0])).toBe(true);
		expect(
			(batches[0] as { params: unknown[] }[]).every(
				(member) => member.params.at(-1) === "0xa",
			),
		).toBe(true);
	});
	it.each([
		["unrelated ids", (rows: any[]) => rows.map((row) => ({ ...row, id: row.id + 1_000_000 }))],
		["duplicate ids", (rows: any[]) => rows.map((row) => ({ ...row, id: rows[0].id }))],
		["missing member", (rows: any[]) => rows.slice(1)],
		["extra member", (rows: any[]) => [...rows, { ...rows[0], id: -1 }]],
		[
			"ambiguous result and error",
			(rows: any[]) =>
				rows.map((row) => ({
					...row,
					error: { code: -32602, message: "conflicting evidence" },
				})),
		],
	] as const)("rejects the entire batch for %s", async (_name, mutate) => {
		const { client } = await rpc(false, mutate);
		const result = await Promise.allSettled([
			client.getBytecode({ address, blockNumber: 10n }),
			client.getStorageAt({ address, slot: zeroWord as `0x${string}`, blockNumber: 10n }),
		]);
		expect(result.map((item) => item.status)).toEqual(["rejected", "rejected"]);
	});
	it("uses an isolated injected fetch while retaining strict response validation", async () => {
		const { url } = await rpc();
		const fetch = async (_input: unknown, init?: RequestInit) => {
			const rows = JSON.parse(init!.body as string) as { id: number }[];
			return new Response(
				JSON.stringify(
					rows.map((row) => ({ jsonrpc: "2.0", id: row.id, result: "0x6001" })),
				),
				{ headers: { "content-type": "application/json" } },
			);
		};
		const client = createSubmissionReadClient(url, "profile-fetch", { fetchFn: fetch });
		expect(await client.getBytecode({ address, blockNumber: 10n })).toBe("0x6001");
	});
	it("rejects an errored batch member instead of treating its neighbours as evidence", async () => {
		const { client } = await rpc(true);
		const result = await Promise.allSettled([
			client.getBytecode({ address, blockNumber: 10n }),
			client.getStorageAt({ address, slot: zeroWord as `0x${string}`, blockNumber: 10n }),
		]);
		expect(result[0]).toMatchObject({ status: "fulfilled", value: "0x6000" });
		expect(result[1]).toMatchObject({
			status: "rejected",
			reason: { message: expect.stringContaining("Sepolia RPC request failed") },
		});
	});
});
