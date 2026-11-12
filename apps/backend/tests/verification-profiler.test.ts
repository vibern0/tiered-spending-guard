import { describe, expect, it } from "vitest";
import { VerificationProfiler } from "../scripts/verification-profiler";

const endpoints = [
	"https://one.invalid/PRIVATE_RPC_KEY",
	"https://two.invalid/PRIVATE_RPC_KEY",
] as const;
const call = (method = "eth_call") => ({
	jsonrpc: "2.0",
	id: 1,
	method,
	params: ["PRIVATE_ADDRESS"],
});
const options = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("local verification profiler", () => {
	it("records phase elapsed/CPU time and failure status without retaining results or errors", async () => {
		const profiler = new VerificationProfiler();
		expect(await profiler.phase("restore", async () => "PRIVATE_RESULT", 2)).toBe(
			"PRIVATE_RESULT",
		);
		await expect(
			profiler.phase(
				"verification",
				async () => {
					throw new Error("PRIVATE_ERROR");
				},
				2,
			),
		).rejects.toThrow("PRIVATE_ERROR");
		const report = profiler.report();
		expect(report.summary.phases).toMatchObject([
			{ name: "restore", sample: 2, status: "ok" },
			{ name: "verification", sample: 2, status: "error" },
		]);
		for (const phase of report.summary.phases) {
			expect(phase.wallMs).toBeGreaterThanOrEqual(0);
			expect(phase.cpuUserMs).toBeGreaterThanOrEqual(0);
			expect(phase.cpuSystemMs).toBeGreaterThanOrEqual(0);
		}
		expect(report.traceEvents.filter((event) => event.ph === "X")).toHaveLength(2);
		expect(JSON.stringify(report)).not.toContain("PRIVATE");
	});

	it("counts batch calls and only consumed response bytes through stream completion", async () => {
		const profiler = new VerificationProfiler();
		let reads = 0;
		const source = new Response(
			new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						reads++;
						if (reads === 1) controller.enqueue(new TextEncoder().encode("abc"));
						else {
							await sleep(20);
							controller.enqueue(new TextEncoder().encode("de"));
							controller.close();
						}
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 202, statusText: "Accepted", headers: { "x-private": "PRIVATE_HEADER" } },
		);
		Object.defineProperties(source, {
			url: { value: endpoints[0] },
			redirected: { value: true },
		});
		const wrapped = profiler.wrapFetch(async () => source, endpoints);
		const response = await wrapped(
			endpoints[0],
			options([call(), { ...call("eth_getCode"), id: 2 }]),
		);
		expect(reads).toBe(0);
		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Accepted");
		expect(response.url).toBe(endpoints[0]);
		expect(response.redirected).toBe(true);
		expect(response.headers.get("x-private")).toBe("PRIVATE_HEADER");
		expect(profiler.report().summary.http[0].bytes).toBe(0);
		expect(await response.text()).toBe("abcde");
		const report = profiler.report();
		expect(report.summary.http[0]).toMatchObject({
			provider: "provider-1",
			requests: 1,
			rpcCalls: 2,
			bytes: 5,
			batchSizes: [2],
			failures: 0,
			cancelled: 0,
		});
		expect(report.summary.http[0].wallMs).toBeGreaterThanOrEqual(15);
		expect(report.summary.rpcMethods).toEqual({ eth_call: 1, eth_getCode: 1 });
		expect(JSON.stringify(report)).not.toContain("PRIVATE");
	});

	it("blocks writes, unknown methods, endpoints, and malformed batches before any transport", async () => {
		const profiler = new VerificationProfiler();
		const wrapped = profiler.wrapFetch(async () => {
			throw new Error("TRANSPORT_REACHED");
		}, endpoints);
		for (const body of [
			call("eth_sendRawTransaction"),
			call("personal_sign"),
			call("PRIVATE_METHOD"),
			[],
			[call(), call("eth_sendTransaction")],
			{ params: [] },
			"invalid",
		]) {
			await expect(wrapped(endpoints[0], options(body))).rejects.toThrow(
				"Profiling request rejected",
			);
		}
		await expect(wrapped("https://other.invalid/PRIVATE_KEY", options(call()))).rejects.toThrow(
			"Profiling request rejected",
		);
		await expect(
			wrapped(endpoints[0], { method: "POST", body: "PRIVATE_INVALID_JSON" }),
		).rejects.toThrow("Profiling request rejected");
		expect(profiler.report().summary.http.every((provider) => provider.requests === 0)).toBe(
			true,
		);
		expect(JSON.stringify(profiler.report())).not.toContain("PRIVATE");
	});

	it("records failed fetches with redacted traces while preserving the caller error and abort signal", async () => {
		const profiler = new VerificationProfiler();
		const abort = new AbortController();
		const failure = new Error("PRIVATE_FETCH_ERROR");
		const wrapped = profiler.wrapFetch(async (_input, init) => {
			expect(init?.signal).toBe(abort.signal);
			expect(init?.redirect).toBe("error");
			throw failure;
		}, endpoints);
		await expect(
			wrapped(endpoints[1], { ...options(call("eth_chainId")), signal: abort.signal }),
		).rejects.toBe(failure);
		const report = profiler.report();
		expect(report.summary.http[1]).toMatchObject({
			requests: 1,
			rpcCalls: 1,
			bytes: 0,
			failures: 1,
		});
		expect(report.traceEvents.filter((event) => event.ph === "e")).toMatchObject([
			{ args: { status: "error" } },
		]);
		expect(JSON.stringify(report)).not.toContain("PRIVATE");
	});

	it("forwards stream cancellation once without logging the reason", async () => {
		const profiler = new VerificationProfiler();
		let cancellation: unknown;
		const wrapped = profiler.wrapFetch(
			async () =>
				new Response(
					new ReadableStream(
						{
							cancel(reason) {
								cancellation = reason;
							},
						},
						{ highWaterMark: 0 },
					),
				),
			endpoints,
		);
		const response = await wrapped(endpoints[0], options(call()));
		await response.body!.cancel("PRIVATE_CANCEL");
		expect(cancellation).toBe("PRIVATE_CANCEL");
		expect(profiler.report().summary.http[0]).toMatchObject({
			cancelled: 1,
			failures: 0,
			bytes: 0,
		});
		expect(profiler.report().traceEvents.filter((event) => event.ph === "e")).toHaveLength(1);
		expect(JSON.stringify(profiler.report())).not.toContain("PRIVATE");
	});

	it("counts intentional aborts as cancellation rather than provider failure", async () => {
		const profiler = new VerificationProfiler(),
			abort = new AbortController();
		const wrapped = profiler.wrapFetch(async (_input, _init) => {
			abort.abort();
			throw new DOMException("PRIVATE_ABORT", "AbortError");
		}, endpoints);
		await expect(
			wrapped(endpoints[0], { ...options(call()), signal: abort.signal }),
		).rejects.toThrow("PRIVATE_ABORT");
		expect(profiler.report().summary.http[0]).toMatchObject({ cancelled: 1, failures: 0 });
		expect(JSON.stringify(profiler.report())).not.toContain("PRIVATE");
	});
	it("records body read failure without retaining the stream error", async () => {
		const profiler = new VerificationProfiler();
		const wrapped = profiler.wrapFetch(
			async () =>
				new Response(
					new ReadableStream(
						{
							pull(controller) {
								controller.error(new Error("PRIVATE_STREAM_ERROR"));
							},
						},
						{ highWaterMark: 0 },
					),
				),
			endpoints,
		);
		const response = await wrapped(endpoints[0], options(call()));
		await expect(response.text()).rejects.toThrow("PRIVATE_STREAM_ERROR");
		expect(profiler.report().summary.http[0].failures).toBe(1);
		expect(JSON.stringify(profiler.report())).not.toContain("PRIVATE");
	});

	it("gives overlapping requests distinct async span IDs and stable provider tracks", async () => {
		const profiler = new VerificationProfiler();
		const wrapped = profiler.wrapFetch(async () => new Response("ok"), endpoints);
		const responses = await Promise.all([
			wrapped(endpoints[0], options(call())),
			wrapped(endpoints[0], options(call())),
		]);
		const starts = profiler.report().traceEvents.filter((event) => event.ph === "b");
		expect(starts).toHaveLength(2);
		expect(new Set(starts.map((event) => event.id)).size).toBe(2);
		expect(profiler.report().traceEvents.filter((event) => event.ph === "e")).toHaveLength(0);
		await Promise.all(responses.map((response) => response.text()));
		const report = profiler.report();
		const ends = report.traceEvents.filter((event) => event.ph === "e");
		expect(ends.map((event) => event.id).sort()).toEqual(
			starts.map((event) => event.id).sort(),
		);
		expect(
			report.traceEvents.filter((event) => event.ph === "M" && event.name === "thread_name"),
		).toHaveLength(3);
		expect(report.summary.http[0]).toMatchObject({ requests: 2, bytes: 4, batchSizes: [1, 1] });
	});

	it("validates the same immutable request options that reach the transport", async () => {
		const profiler = new VerificationProfiler();
		const request = new Request(endpoints[0], options(call("eth_getBalance")));
		const mutableOptions: RequestInit = { headers: { "x-test": "PRIVATE_HEADER" } };
		let forwardedBody: BodyInit | null | undefined;
		const wrapped = profiler.wrapFetch(async (_input, init) => {
			forwardedBody = init?.body;
			return new Response("ok");
		}, endpoints);
		const pending = wrapped(request, mutableOptions);
		mutableOptions.body = JSON.stringify(call("eth_sendTransaction"));
		const response = await pending;
		await response.text();
		expect(forwardedBody).toBeUndefined();
		expect(profiler.report().summary.rpcMethods).toEqual({ eth_getBalance: 1 });
	});

	it("does not allow mutation of a report to alter subsequent measurements", async () => {
		const profiler = new VerificationProfiler();
		const first = profiler.report();
		first.summary.http[0].batchSizes.push(999);
		first.traceEvents.length = 0;
		expect(profiler.report().summary.http[0].batchSizes).toEqual([]);
		expect(profiler.report().traceEvents.length).toBeGreaterThan(0);
	});
});
