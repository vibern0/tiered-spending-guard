import { type Hex } from "viem";
import {
  canonicalSubmissionJson,
  snapshotSubmissionRequest,
  submissionRequestHash,
} from "./validate";
import { type SubmissionRequest, type SubmissionResult, type SubmissionTransport } from "./types";

const MAX_RESPONSE_BYTES = 65_536;
const RESULT_KINDS = ["submitted", "confirmed", "reverted", "stale", "unsupported-chain", "rpc-inconsistent", "transport-unavailable"] as const;
const TERMINAL_KINDS = new Set(["reverted", "stale", "unsupported-chain", "rpc-inconsistent", "transport-unavailable"]);
const SENSITIVE = /private|secret|mnemonic|seed|pin|credential|provider|rpc|passkey|ecdsaSecondary|signature/i;

type Options = Readonly<{ endpoint: URL; fetch: typeof globalThis.fetch; timeoutMs: number }>;

function unavailable(requestHash: Hex, reason: string): SubmissionResult {
  return Object.freeze({ kind: "transport-unavailable", requestHash, reason: sanitize(reason) });
}

function sanitize(reason: string): string {
  if (SENSITIVE.test(reason) || /0x[0-9a-f]{32,}/i.test(reason)) return "submission transport unavailable";
  return reason.slice(0, 160);
}

function assertEndpoint(endpoint: URL): URL {
  if (endpoint.protocol !== "https:") throw new Error("submission endpoint must be HTTPS");
  if (endpoint.username || endpoint.password) throw new Error("submission endpoint must not contain credentials");
  return new URL(endpoint.toString());
}

function assertResponseIdentity(response: Response, endpoint: URL): void {
  if (response.redirected) throw new Error("redirected response rejected");
  if (response.url) {
    const responseUrl = new URL(response.url);
    if (responseUrl.origin !== endpoint.origin) throw new Error("cross-origin response rejected");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (SENSITIVE.test(key)) throw new Error(`sensitive ${label} field`);
    if (!expected.includes(key)) throw new Error(`unknown ${label} field`);
  }
  for (const key of expected) if (!(key in value)) throw new Error(`${label}.${key} is required`);
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be bytes32`);
  return value as Hex;
}

function decimalBigint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a decimal string`);
  return BigInt(value);
}

function nonemptyReason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || SENSITIVE.test(value)) throw new Error("invalid result reason");
  return value.slice(0, 512);
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("response must be JSON");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) throw new Error("response content length is malformed");
    if (BigInt(contentLength) > BigInt(MAX_RESPONSE_BYTES)) throw new Error("response body too large");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("response body too large");
  return JSON.parse(text) as unknown;
}

function parseResult(input: unknown, expectedRequestHash: Hex): SubmissionResult {
  if (!isRecord(input)) throw new Error("submission result must be an object");
  const kind = input.kind;
  if (typeof kind !== "string" || !RESULT_KINDS.includes(kind as never)) throw new Error("unsupported result kind");
  if (kind === "submitted") {
    exact(input, ["kind", "requestHash", "transactionHash"], "result");
    const requestHash = hash(input.requestHash, "requestHash");
    if (requestHash !== expectedRequestHash) throw new Error("request hash mismatch");
    return Object.freeze({ kind, requestHash, transactionHash: hash(input.transactionHash, "transactionHash") });
  }
  if (kind === "confirmed") {
    exact(input, ["kind", "requestHash", "transactionHash", "blockNumber", "blockHash"], "result");
    const requestHash = hash(input.requestHash, "requestHash");
    if (requestHash !== expectedRequestHash) throw new Error("request hash mismatch");
    return Object.freeze({ kind, requestHash, transactionHash: hash(input.transactionHash, "transactionHash"), blockNumber: decimalBigint(input.blockNumber, "blockNumber"), blockHash: hash(input.blockHash, "blockHash") });
  }
  if (TERMINAL_KINDS.has(kind)) {
    exact(input, ["kind", "requestHash", "reason"], "result");
    const requestHash = hash(input.requestHash, "requestHash");
    if (requestHash !== expectedRequestHash) throw new Error("request hash mismatch");
    return Object.freeze({ kind: kind as "reverted" | "stale" | "unsupported-chain" | "rpc-inconsistent" | "transport-unavailable", requestHash, reason: nonemptyReason(input.reason) });
  }
  throw new Error("unsupported result kind");
}

export function createHttpsSubmissionTransport(options: Options): SubmissionTransport {
  const endpoint = assertEndpoint(options.endpoint);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");
  const idempotency = new Map<Hex, string>();

  return Object.freeze({
    async submit(input: SubmissionRequest): Promise<SubmissionResult> {
      let request: SubmissionRequest;
      let body: string;
      let requestHash: Hex;
      try {
        request = snapshotSubmissionRequest(input);
        body = canonicalSubmissionJson({ version: 1, requestHash: submissionRequestHash(request), request });
        requestHash = submissionRequestHash(request);
        const previous = idempotency.get(request.idempotencyKey);
        const canonicalPayload = canonicalSubmissionJson(request);
        if (previous !== undefined && previous !== canonicalPayload) return unavailable(requestHash, "idempotency key reused with a different payload");
        idempotency.set(request.idempotencyKey, canonicalPayload);
      } catch (error) {
        return unavailable("0x0000000000000000000000000000000000000000000000000000000000000000", error instanceof Error ? error.message : "invalid submission request");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await options.fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          redirect: "error",
          signal: controller.signal,
        });
        assertResponseIdentity(response, endpoint);
        if (!response.ok) throw new Error(`submission endpoint returned HTTP ${response.status}`);
        return parseResult(await readJson(response), requestHash);
      } catch (error) {
        return unavailable(requestHash, error instanceof Error ? error.message : "network failure");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
