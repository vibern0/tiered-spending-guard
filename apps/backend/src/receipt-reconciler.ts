import { writeBackendLog, type BackendLogger } from "./logging";

/** A read-only sweep. Retry only after completion, never alongside an earlier sweep. */
export function startReceiptReconciler(
  reconcilePending: () => Promise<void>,
  options: Readonly<{ log?: BackendLogger }> = {},
): Readonly<{ stop(): Promise<void> }> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void>;
  const run = () => {
    flight = Promise.resolve()
      .then(reconcilePending)
      .catch(() => {
        (options.log ?? writeBackendLog)({
          level: "warn",
          code: "receipt_reconciliation_failed",
          stage: "receipt-reconciliation",
          message: "Pending receipt verification failed safely; retrying later",
        });
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(run, 12_000);
          timer.unref();
        }
      });
  };
  run();
  return Object.freeze({
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await flight;
    },
  });
}
