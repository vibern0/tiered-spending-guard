import { expect } from "chai";
import { getAddress, hashTypedData, keccak256, type Hex } from "viem";
import { SAFE_TX_TYPES, type SafeTxMessage } from "../../../../sdk/src/signers/types";
import { createHttpsSubmissionTransport } from "../../../../sdk/src/transport/https";
import { type SafeExecutionRequest, type SubmissionResult } from "../../../../sdk/src/transport/types";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const sig = `0x${"22".repeat(65)}` as Hex;
const safe = a(1);
const zero = a(0);

const transaction: SafeTxMessage = {
  to: a(2),
  value: 12n,
  data: "0x" as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: zero,
  refundReceiver: zero,
  nonce: 3n,
};

const request = (idempotencyKey = h(1)): SafeExecutionRequest => ({
  version: 1,
  kind: "safe-execution",
  idempotencyKey,
  chainId: 11155111,
  deploymentsHash: h(2),
  policyHash: h(3),
  safe,
  guard: a(4),
  asset: a(5),
  transaction,
  safeTxHash: hashTypedData({ domain: { chainId: 11155111, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: transaction }),
  signatures: sig,
  expectedSpend: { window: 0n, baseSpent: 0n, instantSpent: 12n },
});

type FetchCall = Readonly<{ url: string; init: RequestInit }>;

function jsonResponse(value: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

function submitted(requestHash: Hex): SubmissionResult {
  return { kind: "submitted", requestHash, transactionHash: h(9) };
}

describe("HTTPS submission transport", () => {
  it("rejects non-HTTPS endpoints and embedded credentials before submit", () => {
    expect(() => createHttpsSubmissionTransport({ endpoint: new URL("http://relay.example/submit"), fetch: globalThis.fetch, timeoutMs: 1000 })).to.throw(/HTTPS/i);
    expect(() => createHttpsSubmissionTransport({ endpoint: new URL("https://user:pass@relay.example/submit"), fetch: globalThis.fetch, timeoutMs: 1000 })).to.throw(/credentials/i);
  });

  it("posts one canonical JSON request over HTTPS with redirect disabled and validates the response hash", async () => {
    const calls: FetchCall[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { requestHash: Hex; request: Record<string, unknown> };
      expect(body.request.kind).to.equal("safe-execution");
      expect(body.request.transaction).to.include({ value: "12", nonce: "3" });
      expect(String(init?.body)).not.to.contain("12n");
      expect(String(init?.body)).not.to.match(/privateKey|passkeyMaterial|ecdsaSecondaryPin|rpc|providerCredentials/i);
      return jsonResponse(submitted(body.requestHash));
    };
    const transport = createHttpsSubmissionTransport({ endpoint: new URL("https://relay.example/submit"), fetch: fetcher as typeof globalThis.fetch, timeoutMs: 1000 });

    const result = await transport.submit(request());

    expect(result.kind).to.equal("submitted");
    expect(Object.isFrozen(result)).to.equal(true);
    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal("https://relay.example/submit");
    expect(calls[0].init.method).to.equal("POST");
    expect(calls[0].init.redirect).to.equal("error");
    expect(calls[0].init.headers).to.deep.equal({ "content-type": "application/json" });
  });

  it("returns immutable parsed submission result variants", async () => {
    const variants = [
      (requestHash: Hex) => ({ kind: "submitted", requestHash, transactionHash: h(10) }),
      (requestHash: Hex) => ({ kind: "confirmed", requestHash, transactionHash: h(11), blockNumber: "123", blockHash: h(12) }),
      (requestHash: Hex) => ({ kind: "stale", requestHash, reason: "already superseded" }),
    ] as const;

    for (const [index, variant] of variants.entries()) {
      const transport = createHttpsSubmissionTransport({
        endpoint: new URL(`https://relay.example/immutable-${index}`),
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { requestHash: Hex };
          return jsonResponse(variant(body.requestHash));
        }) as typeof globalThis.fetch,
        timeoutMs: 1000,
      });

      const result = await transport.submit(request(h(150 + index)));

      expect(Object.isFrozen(result)).to.equal(true);
    }
  });

  it("rejects duplicate idempotency keys with a different canonical payload before fetching", async () => {
    let calls = 0;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { requestHash: Hex };
      return jsonResponse(submitted(body.requestHash));
    };
    const transport = createHttpsSubmissionTransport({ endpoint: new URL("https://relay.example/submit"), fetch: fetcher as typeof globalThis.fetch, timeoutMs: 1000 });
    await transport.submit(request(h(77)));

    const result = await transport.submit({ ...request(h(77)), expectedSpend: { window: 0n, baseSpent: 1n, instantSpent: 12n } });

    expect(result).to.include({ kind: "transport-unavailable" });
    expect(result.reason).to.match(/idempotency/i);
    expect(calls).to.equal(1);
  });

  it("fails closed on redirects, cross-origin response identity, unknown fields, and request hash mismatches", async () => {
    const redirected = jsonResponse(submitted(h(1)));
    Object.defineProperty(redirected, "redirected", { value: true });
    const crossOrigin = jsonResponse(submitted(h(1)));
    Object.defineProperty(crossOrigin, "url", { value: "https://other.example/submit" });
    const scenarios: readonly [string, unknown][] = [
      ["redirect", redirected],
      ["origin", crossOrigin],
      ["unknown", { kind: "submitted", requestHash: h(1), transactionHash: h(2), extra: true }],
      ["hash", { kind: "submitted", requestHash: h(999), transactionHash: h(2) }],
    ];

    for (const [label, response] of scenarios) {
      const transport = createHttpsSubmissionTransport({
        endpoint: new URL(`https://relay.example/${label}`),
        fetch: (async () => response instanceof Response ? response : jsonResponse(response)) as typeof globalThis.fetch,
        timeoutMs: 1000,
      });
      const result = await transport.submit(request(keccak256(`0x${label.charCodeAt(0).toString(16)}` as Hex)));
      expect(result.kind, label).to.equal("transport-unavailable");
    }
  });

  it("fails closed on sensitive response fields, non-JSON bodies, and oversized bodies", async () => {
    const responses: readonly Response[] = [
      jsonResponse({ kind: "submitted", requestHash: h(1), transactionHash: h(2), signatures: sig }),
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response(`{"kind":"submitted","padding":"${"x".repeat(70_000)}"}`, { status: 200, headers: { "content-type": "application/json" } }),
    ];

    for (const [index, response] of responses.entries()) {
      const transport = createHttpsSubmissionTransport({
        endpoint: new URL(`https://relay.example/${index}`),
        fetch: (async () => response) as typeof globalThis.fetch,
        timeoutMs: 1000,
      });
      const result = await transport.submit(request(h(300 + index)));
      expect(result.kind).to.equal("transport-unavailable");
      expect(result.reason).not.to.contain(sig);
    }
  });

  it("enforces oversized response limits using declared and encoded byte length", async () => {
    const contentLengthTooLarge = jsonResponse(submitted(h(1)), { headers: { "content-length": "65537" } });
    const byteLengthTooLarge = new Response(`{"kind":"submitted","requestHash":"${h(1)}","transactionHash":"${h(2)}","padding":"${"€".repeat(22000)}"}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    for (const [index, response] of [contentLengthTooLarge, byteLengthTooLarge].entries()) {
      const transport = createHttpsSubmissionTransport({
        endpoint: new URL(`https://relay.example/byte-limit-${index}`),
        fetch: (async () => response) as typeof globalThis.fetch,
        timeoutMs: 1000,
      });

      const result = await transport.submit(request(h(500 + index)));

      expect(result).to.include({ kind: "transport-unavailable" });
      expect(result.reason).to.match(/too large/i);
    }
  });

  it("normalizes timeout and network failures without exposing request bodies or signatures", async () => {
    const failures: readonly (() => Promise<Response>)[] = [
      async () => { throw new Error(`socket closed ${sig}`); },
      async (_url?: unknown, init?: unknown) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        throw new Error("unreachable");
      },
    ];

    for (const [index, fetcher] of failures.entries()) {
      const transport = createHttpsSubmissionTransport({
        endpoint: new URL(`https://relay.example/fail-${index}`),
        fetch: fetcher as typeof globalThis.fetch,
        timeoutMs: index === 0 ? 1000 : 1,
      });
      const result = await transport.submit(request(h(400 + index)));
      expect(result.kind).to.equal("transport-unavailable");
      expect(result.reason).not.to.contain(sig);
      expect(result.reason).not.to.match(/signature|privateKey|passkey|ecdsaSecondary/i);
    }
  });
});
