import { useEffect, useMemo, useRef, useState } from "react";
import type { SubmissionStatus } from "./vault-store";

const INTERVAL_MS = 5_000;
const STATES: readonly SubmissionStatus["state"][] = [
  "prepared",
  "awaiting-primary",
  "awaiting-secondary",
  "submitting",
  "uncertain",
  "confirmed",
  "reverted",
  "superseded",
];
const terminal = (status: SubmissionStatus) =>
  status.state === "confirmed" || status.state === "reverted" || status.state === "superseded";
const pendingHash = (status: SubmissionStatus) =>
  (status.state === "submitting" || status.state === "uncertain") &&
  /^0x[0-9a-fA-F]{64}$/.test(status.transactionHash ?? "");
const EMPTY_STATUSES: Readonly<Record<string, SubmissionStatus>> = Object.freeze(
  Object.create(null),
);

type Options = {
  scope: string;
  enabled: boolean;
  ids: readonly string[];
  read: (id: string) => Promise<SubmissionStatus>;
  isCurrent: () => boolean;
  onTerminal: () => Promise<void>;
  isCovered: (status: SubmissionStatus) => boolean;
};

/** Account-scoped, read-only receipt tracking. Never prepares or submits transactions. */
export function useSubmissionStatuses(options: Options) {
  const [projection, setProjection] = useState<{
    scope: string;
    values: Readonly<Record<string, SubmissionStatus>>;
  }>({ scope: options.scope, values: EMPTY_STATUSES });
  const onTerminal = useRef(options.onTerminal);
  onTerminal.current = options.onTerminal;
  const isCovered = useRef(options.isCovered);
  isCovered.current = options.isCovered;
  const { scope, enabled, read, isCurrent } = options;
  const tracker = useMemo(() => {
    const values: Record<string, SubmissionStatus> = Object.create(null);
    const ids = new Set<string>();
    const notified = new Set<string>();
    const fresh = new Set<string>();
    let restored = false;
    let refreshTail = Promise.resolve();
    let refreshNext: Promise<void> | undefined;
    const attempts = new Map<string, number>();
    const revisions = new Map<string, number>();
    const flights = new Map<string, Promise<SubmissionStatus>>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = true;
    const active = () => enabled && !stopped && isCurrent();
    // Same-sweep completions share a refresh; later completions queue behind it.
    const refreshTerminal = () => {
      if (!refreshNext) {
        const operation = refreshTail.then(async () => {
          refreshNext = undefined;
          if (active()) await onTerminal.current();
        });
        refreshNext = operation;
        refreshTail = operation.catch(() => {});
      }
      return refreshNext;
    };
    const publish = async (status: SubmissionStatus, refresh: boolean) => {
      const previous = values[status.id];
      if (!active() || (previous && terminal(previous))) return;
      values[status.id] = status;
      setProjection({ scope, values: Object.assign(Object.create(null), values) });
      if (terminal(status) && !notified.has(status.id)) {
        notified.add(status.id);
        if (refresh && status.state !== "superseded") await refreshTerminal();
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!active() || navigator.onLine === false) return;
      let next = Infinity;
      for (const id of ids) {
        if (flights.has(id) || (values[id] && !pendingHash(values[id]))) continue;
        next = Math.min(
          next,
          Math.max(0, (attempts.get(id) ?? -Infinity) + INTERVAL_MS - Date.now()),
        );
      }
      if (next !== Infinity)
        timer = setTimeout(() => {
          for (const id of ids) {
            if (
              !flights.has(id) &&
              (!values[id] || pendingHash(values[id])) &&
              Date.now() - (attempts.get(id) ?? -Infinity) >= INTERVAL_MS
            )
              void fetchStatus(id).catch(() => {
                /* Retry read failures; retain the last known state. */
              });
          }
        }, next);
    };
    const fetchStatus = (id: string): Promise<SubmissionStatus> => {
      const existing = flights.get(id);
      if (existing) return existing;
      if (!active())
        return Promise.reject(new Error("Account session changed; status read ignored"));
      if (navigator.onLine === false)
        return Promise.reject(new Error("Status reads are unavailable while offline"));
      attempts.set(id, Date.now());
      const revision = revisions.get(id) ?? 0;
      const operation = (async () => {
        const status = await read(id);
        if (!active()) throw new Error("Account session changed; status response ignored");
        if (status?.id !== id || !STATES.includes(status.state))
          throw new Error("Submission status response does not match the requested submission");
        if ((revisions.get(id) ?? 0) !== revision) return values[id] ?? status;
        // A concurrent older GET must never regress an already terminal response.
        const previous = values[id];
        // Restored terminal history is already covered by the hydration snapshot.
        await publish(
          status,
          fresh.has(id) || Boolean(previous && pendingHash(previous)) || !isCovered.current(status),
        );
        return values[id] ?? status;
      })();
      flights.set(id, operation);
      void operation
        .finally(() => {
          flights.delete(id);
          schedule();
        })
        .catch(() => {});
      return operation;
    };
    return {
      start() {
        stopped = false;
        schedule();
      },
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
      watch(next: readonly string[]) {
        next.forEach((id) => {
          if (restored && !ids.has(id)) fresh.add(id);
          ids.add(id);
        });
        restored = true;
        schedule();
      },
      read: fetchStatus,
      async observe(status: SubmissionStatus) {
        if (!active()) return;
        revisions.set(status.id, (revisions.get(status.id) ?? 0) + 1);
        attempts.set(status.id, Date.now());
        await publish(status, true);
        schedule();
      },
      resume: schedule,
    };
  }, [scope, enabled, read, isCurrent]);
  useEffect(() => {
    tracker.start();
    window.addEventListener("online", tracker.resume);
    return () => {
      tracker.stop();
      window.removeEventListener("online", tracker.resume);
    };
  }, [tracker]);
  useEffect(() => tracker.watch(options.ids), [tracker, options.ids]);
  return {
    submissions: projection.scope === scope && enabled ? projection.values : EMPTY_STATUSES,
    observeSubmission: tracker.observe,
    readSubmission: tracker.read,
  };
}
