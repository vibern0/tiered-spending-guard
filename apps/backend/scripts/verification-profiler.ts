import { performance } from "node:perf_hooks";

const readMethods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBalance",
  "eth_estimateGas",
  "eth_maxPriorityFeePerGas",
  "eth_gasPrice",
  "eth_feeHistory",
]);
type Phase = "recovery" | "restore" | "verification";
type Status = "ok" | "error" | "cancelled" | "http-error";
type TraceEvent = {
  name: string;
  ph: "M" | "X" | "b" | "e";
  pid: number;
  tid: number;
  ts?: number;
  dur?: number;
  id?: number;
  cat?: string;
  args?: Record<string, unknown>;
};
type PhaseMeasurement = {
  name: Phase;
  sample?: number;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  status: "ok" | "error";
};
type HttpMeasurement = {
  provider: "provider-1" | "provider-2";
  requests: number;
  rpcCalls: number;
  bytes: number;
  batchSizes: number[];
  wallMs: number;
  failures: number;
  cancelled: number;
};
export type VerificationProfileReport = {
  traceEvents: TraceEvent[];
  summary: {
    phases: PhaseMeasurement[];
    http: HttpMeasurement[];
    rpcMethods: Record<string, number>;
  };
};

/** Local diagnostics only. Never retain request/response contents or transport identifiers. */
export class VerificationProfiler {
  private readonly origin = performance.now();
  private readonly traceEvents: TraceEvent[] = [
    { name: "process_name", ph: "M", pid: 1, tid: 1, args: { name: "verification-profiler" } },
    ...["verification", "provider-1", "provider-2"].map((name, index): TraceEvent => ({
      name: "thread_name",
      ph: "M",
      pid: 1,
      tid: index + 1,
      args: { name },
    })),
  ];
  private readonly phases: PhaseMeasurement[] = [];
  private readonly http: HttpMeasurement[] = ["provider-1", "provider-2"].map((provider) => ({
    provider: provider as HttpMeasurement["provider"],
    requests: 0,
    rpcCalls: 0,
    bytes: 0,
    batchSizes: [],
    wallMs: 0,
    failures: 0,
    cancelled: 0,
  }));
  private readonly rpcMethods: Record<string, number> = {};
  private nextId = 1;

  async phase<T>(name: Phase, run: () => Promise<T>, sample?: number): Promise<T> {
    if (
      !["recovery", "restore", "verification"].includes(name) ||
      (sample !== undefined && (!Number.isSafeInteger(sample) || sample < 0))
    ) {
      throw new Error("Profiling phase rejected");
    }
    const start = performance.now();
    const cpu = process.cpuUsage();
    let status: "ok" | "error" = "error";
    try {
      const result = await run();
      status = "ok";
      return result;
    } finally {
      const wallMs = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      const row: PhaseMeasurement = {
        name,
        ...(sample === undefined ? {} : { sample }),
        wallMs,
        cpuUserMs: usage.user / 1_000,
        cpuSystemMs: usage.system / 1_000,
        status,
      };
      this.phases.push(row);
      this.traceEvents.push({
        name,
        cat: "phase",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: (start - this.origin) * 1_000,
        dur: wallMs * 1_000,
        args: {
          ...(sample === undefined ? {} : { sample }),
          status,
          cpuUserMs: row.cpuUserMs,
          cpuSystemMs: row.cpuSystemMs,
        },
      });
    }
  }

  wrapFetch(fetchFn: typeof fetch, providers: readonly [string, string]): typeof fetch {
    let endpoints: string[];
    try {
      endpoints = providers.map((endpoint) => {
        const url = new URL(endpoint);
        if (!["https:", "http:"].includes(url.protocol) || url.hash) throw new Error();
        return url.href;
      });
      if (endpoints.length !== 2 || endpoints[0] === endpoints[1]) throw new Error();
    } catch {
      throw new Error("Profiling providers rejected");
    }

    return async (input, suppliedInit) => {
      const init = suppliedInit === undefined ? undefined : { ...suppliedInit };
      let providerIndex: number;
      let methods: string[];
      try {
        const request = input instanceof Request ? input : undefined;
        const endpoint = new URL(request ? request.url : String(input)).href;
        providerIndex = endpoints.indexOf(endpoint);
        if (
          providerIndex < 0 ||
          (init?.method ?? request?.method ?? "GET").toUpperCase() !== "POST"
        )
          throw new Error();
        const body = init?.body === undefined ? await request?.clone().text() : init.body;
        if (typeof body !== "string") throw new Error();
        const parsed: unknown = JSON.parse(body);
        const calls: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        if (calls.length === 0) throw new Error();
        methods = calls.map((call) => {
          if (call === null || typeof call !== "object" || Array.isArray(call)) throw new Error();
          const { method, jsonrpc } = call as { method?: unknown; jsonrpc?: unknown };
          if (jsonrpc !== "2.0" || typeof method !== "string" || !readMethods.has(method))
            throw new Error();
          return method;
        });
      } catch {
        throw new Error("Profiling request rejected");
      }

      const totals = this.http[providerIndex];
      totals.requests++;
      totals.rpcCalls += methods.length;
      totals.batchSizes.push(methods.length);
      for (const method of methods) this.rpcMethods[method] = (this.rpcMethods[method] ?? 0) + 1;
      const id = this.nextId++;
      const start = performance.now();
      const tid = providerIndex + 2;
      this.traceEvents.push({
        name: "rpc-request",
        cat: "rpc",
        ph: "b",
        pid: 1,
        tid,
        id,
        ts: (start - this.origin) * 1_000,
        args: { provider: totals.provider, batchSize: methods.length, methods },
      });
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      let finished = false;
      let bytes = 0;
      let httpStatus: number | undefined;
      const finish = (status: Status) => {
        if (finished) return;
        finished = true;
        const end = performance.now();
        totals.wallMs += end - start;
        if (status === "error" || status === "http-error") totals.failures++;
        if (status === "cancelled") totals.cancelled++;
        this.traceEvents.push({
          name: "rpc-request",
          cat: "rpc",
          ph: "e",
          pid: 1,
          tid,
          id,
          ts: (end - this.origin) * 1_000,
          args: {
            provider: totals.provider,
            status,
            bytes,
            ...(httpStatus === undefined ? {} : { httpStatus }),
          },
        });
      };
      try {
        // Redirects cannot escape the two explicitly configured read endpoints.
        const response = await fetchFn(input, { ...init, redirect: "error" });
        httpStatus = response.status;
        if (!response.body) {
          finish(response.ok ? "ok" : "http-error");
          return response;
        }
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  finish(response.ok ? "ok" : "http-error");
                  controller.close();
                  reader.releaseLock();
                } else {
                  bytes += chunk.value.byteLength;
                  totals.bytes += chunk.value.byteLength;
                  controller.enqueue(chunk.value);
                }
              } catch (error) {
                finish(signal?.aborted ? "cancelled" : "error");
                controller.error(error);
              }
            },
            async cancel(reason) {
              finish("cancelled");
              try {
                await reader.cancel(reason);
              } finally {
                reader.releaseLock();
              }
            },
          },
          { highWaterMark: 0 },
        );
        const measured = new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        // The Response constructor does not carry these transport fields across.
        Object.defineProperties(measured, {
          url: { value: response.url },
          redirected: { value: response.redirected },
          type: { value: response.type },
        });
        return measured;
      } catch (error) {
        finish(signal?.aborted ? "cancelled" : "error");
        throw error;
      }
    };
  }

  report(): VerificationProfileReport {
    return structuredClone({
      traceEvents: this.traceEvents,
      summary: { phases: this.phases, http: this.http, rpcMethods: this.rpcMethods },
    });
  }
}
