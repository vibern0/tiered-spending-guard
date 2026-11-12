import { http } from "viem";

const MAX_RESPONSE_BYTES = 10_485_760;
const invalid = () => new Error("invalid JSON-RPC batch response");
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
let tenderlyQueue: Promise<unknown> = Promise.resolve();
let tenderlyNextStart = 0;

/** Public Tenderly permits only a small read budget, shared by every client. */
function pacedTenderly<T>(
  members: number,
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const abort = () => {
      if (timer) clearTimeout(timer);
      wake?.();
      reject(signal?.reason ?? new DOMException("Read aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const task = tenderlyQueue.then(async () => {
      signal?.throwIfAborted();
      const delay = tenderlyNextStart - Date.now();
      if (delay > 0)
        await new Promise<void>((resume) => {
          wake = resume;
          timer = setTimeout(resume, delay);
        });
      signal?.throwIfAborted();
      tenderlyNextStart = Date.now() + 125 * members;
      return read();
    });
    // Keep the queue occupied until body consumption/validation finishes, even
    // when its caller has already aborted. Failed reads never poison the queue.
    tenderlyQueue = task.then(
      () => undefined,
      () => undefined,
    );
    const cleanup = () => signal?.removeEventListener("abort", abort);
    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Validate identities before viem's positional batch demultiplexer sees any evidence. */
const checkedFetch =
  (fetchFn: typeof fetch, paced: boolean): typeof fetch =>
  async (input, init) => {
    const requests: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (!Array.isArray(requests) || requests.length === 0) throw invalid();
    const expected = new Set<number>();
    for (const request of requests) {
      if (
        !object(request) ||
        request.jsonrpc !== "2.0" ||
        !Number.isSafeInteger(request.id) ||
        expected.has(request.id as number)
      )
        throw invalid();
      expected.add(request.id as number);
    }
    const read = async () => {
      const response = await fetchFn(input, { ...init, redirect: "error" });
      if (!response.ok && (!paced || !response.body)) return response;
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw invalid();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks, size).toString("utf8");
      // Read error bodies inside the Tenderly slot too; preserve HTTP/RPC retry
      // handling without admitting any successful evidence from those responses.
      if (!response.ok)
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      const replies: unknown = JSON.parse(text);
      if (!Array.isArray(replies) || replies.length !== expected.size) throw invalid();
      const seen = new Set<number>();
      for (const reply of replies) {
        if (
          !object(reply) ||
          reply.jsonrpc !== "2.0" ||
          !Number.isSafeInteger(reply.id) ||
          !expected.has(reply.id as number) ||
          seen.has(reply.id as number)
        )
          throw invalid();
        seen.add(reply.id as number);
        const result = Object.hasOwn(reply, "result"),
          error = Object.hasOwn(reply, "error");
        if (result === error) throw invalid();
        if (
          error &&
          (!object(reply.error) ||
            !Number.isSafeInteger(reply.error.code) ||
            typeof reply.error.message !== "string")
        )
          throw invalid();
      }
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    return paced ? pacedTenderly(requests.length, init?.signal ?? undefined, read) : read();
  };

/** Used only by backend read adapters; signed transaction broadcasts keep their existing transport. */
export function batchedReadTransport(url: string, fetchFn?: typeof fetch) {
  // The public Tenderly reader rejects larger batches; retain every call in
  // separately validated groups rather than retrying an oversized request.
  return http(url, {
    batch: { batchSize: 4, wait: 0 },
    fetchFn: checkedFetch(
      (input, init) => (fetchFn ?? fetch)(input, init),
      url === "https://sepolia.gateway.tenderly.co",
    ),
  });
}
